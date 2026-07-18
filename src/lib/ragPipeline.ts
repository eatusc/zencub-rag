import OpenAI from "openai";
import type { getServerEnv } from "@/lib/env";
import {
  CANDIDATE_POOL,
  RERANK_POOL,
  capPerVideo,
  enrichWithTechniques,
  filterDegenerate,
  rerankWithLLM,
  rrfFuse,
} from "@/lib/ragRetrieval";
import { formatRagSource, type RagSource } from "@/lib/ragUtils";
import { createServerSupabase } from "@/lib/supabase";
import { refineResultTimestamps } from "@/lib/timestampRefinement";
import type { RagConversationTurn, RagSearchResult } from "@/lib/types";

type ServerEnv = ReturnType<typeof getServerEnv>;

export const RESULT_LIMIT = 8;
export type RequestedRetrieval = "text" | "vector" | "auto";
export type RetrievalMode = "vector" | "text" | "metadata" | "hybrid";

export function normalizeConversation(value: unknown): RagConversationTurn[] {
  if (!Array.isArray(value)) return [];
  const turns = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const question = typeof raw.question === "string" ? raw.question.trim().slice(0, 1_000) : "";
    const answer = typeof raw.answer === "string" ? raw.answer.trim().slice(0, 6_000) : "";
    return question && answer ? [{ question, answer }] : [];
  });
  return turns.length <= 6 ? turns : [turns[0], ...turns.slice(-5)];
}

export function normalizeContextIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 12);
}

export function uniqueRows(rows: RagSearchResult[]): RagSearchResult[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export async function vectorResults(query: string, limit: number, openai: OpenAI | null, env: ServerEnv) {
  if (!openai) return [];
  const embedding = await openai.embeddings.create({
    model: env.ragEmbeddingModel,
    input: query,
  });
  const queryEmbedding = embedding.data[0]?.embedding;
  if (!queryEmbedding) return [];

  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("match_rag_transcript_chunks", {
    query_embedding: queryEmbedding,
    match_count: limit,
    filter_video_id: null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as RagSearchResult[]).map((result) => ({
    ...result,
    rank: result.similarity ?? result.rank ?? 0,
  }));
}

export async function textResults(query: string, limit: number) {
  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("search_rag_transcript_chunks", {
    query_text: query,
    match_count: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as RagSearchResult[];
}

const METADATA_STOP_WORDS = new Set([
  "about", "after", "again", "from", "have", "into", "their", "then", "they", "this", "what", "when", "where", "with", "your",
  "how", "the", "and", "for", "that", "you", "can", "stop", "help",
]);

type TechniqueSearchRow = {
  video_id: string;
  technique_name: string | null;
  canonical_position: string | null;
  position: string | null;
  type: string | null;
  gi_nogi: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
};

function metadataTerms(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((term) => term.length >= 3 && !METADATA_STOP_WORDS.has(term)),
  )].slice(0, 5);
}

function techniqueScore(row: TechniqueSearchRow, terms: string[]): number {
  const searchable = [row.technique_name, row.canonical_position, row.position, row.type, row.gi_nogi]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.reduce((score, term) => score + (searchable.includes(term) ? 1 : 0), 0);
}

/**
 * Metadata retrieval searches structured technique/position labels first, then
 * maps matching technique time ranges back to transcript chunks. Terms are
 * restricted to ASCII alphanumerics before being inserted into PostgREST's OR
 * filter, so arbitrary user syntax never reaches the filter expression.
 */
export async function metadataResults(query: string, limit: number): Promise<RagSearchResult[]> {
  const terms = metadataTerms(query);
  if (terms.length === 0) return [];

  const fields = ["technique_name", "canonical_position", "position", "type", "gi_nogi"];
  const orFilter = terms.flatMap((term) => fields.map((field) => `${field}.ilike.%${term}%`)).join(",");
  const supabase = createServerSupabase();
  const { data: techniqueData, error: techniqueError } = await supabase
    .from("rag_techniques")
    .select("video_id,technique_name,canonical_position,position,type,gi_nogi,start_seconds,end_seconds")
    .or(orFilter)
    .limit(Math.max(limit * 3, 30));
  if (techniqueError) throw new Error(techniqueError.message);

  const techniques = (techniqueData ?? []) as TechniqueSearchRow[];
  const videoIds = [...new Set(techniques.map((row) => row.video_id))];
  if (videoIds.length === 0) return [];

  const { data: chunkData, error: chunkError } = await supabase
    .from("rag_transcript_chunks")
    .select("id,video_id,chunk_index,start_seconds,end_seconds,text,metadata")
    .in("video_id", videoIds)
    .limit(Math.max(limit * 8, 80));
  if (chunkError) throw new Error(chunkError.message);

  const ranked = ((chunkData ?? []) as Omit<RagSearchResult, "rank">[]).flatMap((chunk) => {
    const chunkStart = Number(chunk.start_seconds) || 0;
    const chunkEnd = Number(chunk.end_seconds) || chunkStart;
    const matching = techniques.filter((technique) => {
      if (technique.video_id !== chunk.video_id) return false;
      const start = Number(technique.start_seconds) || 0;
      const end = Number(technique.end_seconds) || start;
      return Math.max(start, chunkStart) <= Math.min(end, chunkEnd);
    });
    const score = matching.reduce((best, technique) => Math.max(best, techniqueScore(technique, terms)), 0);
    return score > 0 ? [{ ...chunk, rank: score }] : [];
  });

  return uniqueRows(ranked.sort((a, b) => b.rank - a.rank)).slice(0, limit);
}

export async function contextResults(ids: string[]): Promise<RagSearchResult[]> {
  if (ids.length === 0) return [];
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_transcript_chunks")
    .select("id,video_id,chunk_index,start_seconds,end_seconds,text,metadata")
    .in("id", ids);
  if (error) throw new Error(error.message);

  const byId = new Map(((data ?? []) as Omit<RagSearchResult, "rank">[]).map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ ...row, rank: 0 }] : [];
  });
}

export async function buildCandidates(
  query: string,
  requestedRetrieval: RequestedRetrieval,
  openai: OpenAI | null,
  env: ServerEnv,
): Promise<{ retrieval: RetrievalMode; rows: RagSearchResult[] }> {
  if (requestedRetrieval === "text") {
    const rows = capPerVideo(filterDegenerate(await textResults(query, CANDIDATE_POOL)));
    return { retrieval: "text", rows };
  }
  if (requestedRetrieval === "vector") {
    const rows = capPerVideo(filterDegenerate(await vectorResults(query, CANDIDATE_POOL, openai, env)));
    return { retrieval: "vector", rows };
  }

  const [vectorRaw, textRaw] = await Promise.all([
    vectorResults(query, CANDIDATE_POOL, openai, env).catch(() => [] as RagSearchResult[]),
    textResults(query, CANDIDATE_POOL),
  ]);
  const vector = filterDegenerate(vectorRaw);
  const text = filterDegenerate(textRaw);

  if (vector.length === 0) return { retrieval: "text", rows: capPerVideo(text) };
  if (text.length === 0) return { retrieval: "vector", rows: capPerVideo(vector) };
  return { retrieval: "hybrid", rows: capPerVideo(rrfFuse([vector, text])) };
}

export async function rerankCandidates(
  retrievalQuery: string,
  candidates: RagSearchResult[],
  openai: OpenAI | null,
  env: ServerEnv,
): Promise<{ reranked: RagSearchResult[]; didRerank: boolean }> {
  const pool = candidates.slice(0, RERANK_POOL);
  const didRerank = Boolean(openai && env.ragRerankEnabled);
  const reranked = openai && env.ragRerankEnabled
    ? await rerankWithLLM(retrievalQuery, pool, openai, env.ragRerankModel, RESULT_LIMIT)
    : pool;
  return { reranked, didRerank };
}

export async function enrichCandidates(
  query: string,
  reranked: RagSearchResult[],
): Promise<{ top: RagSearchResult[]; sources: RagSource[] }> {
  const top = await refineResultTimestamps(query, reranked.slice(0, RESULT_LIMIT));
  const enriched = await enrichWithTechniques(top);
  const sources = enriched.map(({ row, technique }, index) => formatRagSource(row, index, technique));
  return { top, sources };
}
