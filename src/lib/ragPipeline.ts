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
export type RetrievalMode = "vector" | "text" | "hybrid";

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

async function vectorResults(query: string, limit: number, openai: OpenAI | null, env: ServerEnv) {
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

async function textResults(query: string, limit: number) {
  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("search_rag_transcript_chunks", {
    query_text: query,
    match_count: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as RagSearchResult[];
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

