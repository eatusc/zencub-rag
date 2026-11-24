import OpenAI from "openai";
import type { getServerEnv } from "@/lib/env";
import {
  CANDIDATE_POOL,
  MAX_PER_VIDEO,
  RERANK_POOL,
  capPerVideo,
  enrichWithTechniques,
  filterDegenerate,
  rerankWithLLM,
  rrfFuse,
} from "@/lib/ragRetrieval";
import { keywordTerms, type RetrievalQueries } from "@/lib/followUpQuery";
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

/** Below this many strict (all-words) matches, keyword search retries with OR. */
export const KEYWORD_RELAX_THRESHOLD = 5;

/** A relaxed match must contain at least this many distinct query terms (or all of them, if fewer). */
export const KEYWORD_RELAX_MIN_TERMS = 2;

/**
 * Any-term keyword search (docs/migrations/2026-11-23-rag-keyword-any.sql).
 * Relaxation is an enhancement, so any failure returns null and the caller
 * keeps its strict results: a missing function (code deployed before the
 * migration), a statement timeout, or anything else. Never fails the request.
 */
export async function textResultsAnyTerm(terms: string[], limit: number): Promise<RagSearchResult[] | null> {
  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("search_rag_transcript_chunks_any", {
    terms,
    match_count: limit,
  });
  if (error) {
    console.warn(`[rag] keyword relaxation unavailable (${error.code ?? "unknown"}): ${error.message}`);
    return null;
  }
  return (data ?? []) as (RagSearchResult & { matched_terms?: number })[];
}

type AnyTermSearch = (terms: string[], limit: number) => Promise<(RagSearchResult & { matched_terms?: number })[] | null>;

/**
 * Keyword search that relaxes AND to OR when the strict query is too narrow.
 * The live function (plainto_tsquery) requires every stem and drops "or" as a
 * stop word, so a long query can match nothing. Below the threshold this asks
 * the any-term function, which ranks chunks by how many distinct terms they
 * contain. Strict matches keep their place at the top; relaxed matches must
 * contain at least KEYWORD_RELAX_MIN_TERMS terms so one common word ("escape")
 * cannot flood the pool.
 */
export async function textResultsRelaxed(
  query: string,
  limit: number,
  search: (query: string, limit: number) => Promise<RagSearchResult[]> = textResults,
  anyTerm: AnyTermSearch = textResultsAnyTerm,
): Promise<{ rows: RagSearchResult[]; relaxed: boolean }> {
  const strict = await search(query, limit);
  if (strict.length >= KEYWORD_RELAX_THRESHOLD) return { rows: strict, relaxed: false };

  const terms = keywordTerms(query).slice(0, 12);
  if (terms.length < 2) return { rows: strict, relaxed: false };

  const loose = await anyTerm(terms, limit);
  if (loose === null) return { rows: strict, relaxed: false };

  const minTerms = Math.min(KEYWORD_RELAX_MIN_TERMS, terms.length);
  const kept = loose
    .filter((row) => (row.matched_terms ?? minTerms) >= minTerms)
    .map(({ matched_terms: _matched, ...row }) => row);
  return { rows: uniqueRows([...strict, ...kept]).slice(0, limit), relaxed: true };
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

/**
 * Most retained sources (the previous answer's citations) a follow-up keeps in
 * its candidate pool. The route used to put all of them (up to 8) first, so
 * with RERANK_POOL 12 only 4 fresh results ever reached the reranker (Codex
 * post-ship review, 2026-11-23).
 */
export const RETAINED_CONTEXT_SLOTS = 4;

/**
 * Merge the previous answer's sources with this turn's fresh retrieval.
 * Retained rows are capped at RETAINED_CONTEXT_SLOTS (best first, since the
 * client sends them in answer order) and interleaved after fresh rows, so the
 * rerank pool holds about 8 fresh and 4 retained candidates.
 *
 * Fresh rows win the per-video cap: a retained row is admitted only if its
 * video still has room after the fresh rows that can reach the rerank pool
 * (the first RERANK_POOL - slots). Capping the interleaved list instead would
 * let two retained chunks of a video push out a better fresh chunk of the same
 * video (Codex review, 2026-11-24).
 */
export function mergeRetainedContext(
  prior: RagSearchResult[],
  fresh: RagSearchResult[],
  slots = RETAINED_CONTEXT_SLOTS,
): RagSearchResult[] {
  const freshRows = capPerVideo(filterDegenerate(uniqueRows(fresh)));
  const freshIds = new Set(freshRows.map((row) => row.id));
  const perVideo = new Map<string, number>();
  for (const row of freshRows.slice(0, Math.max(0, RERANK_POOL - slots))) {
    perVideo.set(row.video_id, (perVideo.get(row.video_id) ?? 0) + 1);
  }
  const kept: RagSearchResult[] = [];
  for (const row of uniqueRows(filterDegenerate(prior))) {
    if (kept.length >= slots) break;
    if (freshIds.has(row.id)) continue;
    const count = perVideo.get(row.video_id) ?? 0;
    if (count >= MAX_PER_VIDEO) continue;
    perVideo.set(row.video_id, count + 1);
    kept.push(row);
  }
  const merged: RagSearchResult[] = [];
  for (let i = 0; i < Math.max(kept.length, freshRows.length); i++) {
    if (i < freshRows.length) merged.push(freshRows[i]);
    if (i < kept.length) merged.push(kept[i]);
  }
  return merged;
}

/**
 * `queries` is either one string for both retrievers (unchanged pre-fix
 * behavior, strict keyword search) or a per-retriever plan from
 * followUpQuery.ts: vector search gets a full sentence, keyword search a short
 * phrase. Keyword relaxation runs only for a model-rewritten phrase and only
 * when RAG_KEYWORD_RELAX=on. 2026-11-23 eval (19 follow-ups x 3 runs, P@8):
 * before 0.491, rewrite 0.570, rewrite + relaxation 0.548; relaxing the joined
 * fallback query scored 0.455. So a failed rewrite behaves exactly like the
 * pre-fix code, and relaxation stays off until it beats the rewrite alone.
 */
export async function buildCandidates(
  queries: string | Pick<RetrievalQueries, "vector" | "keyword" | "rewrite">,
  requestedRetrieval: RequestedRetrieval,
  openai: OpenAI | null,
  env: ServerEnv,
): Promise<{ retrieval: RetrievalMode; rows: RagSearchResult[]; keywordRelaxed: boolean }> {
  const vectorQuery = typeof queries === "string" ? queries : queries.vector;
  const keywordQuery = typeof queries === "string" ? queries : queries.keyword;
  const relax = env.ragKeywordRelax && typeof queries !== "string" && queries.rewrite === "model";
  const keywordSearch = relax
    ? (query: string, limit: number) => textResultsRelaxed(query, limit)
    : async (query: string, limit: number) => ({ rows: await textResults(query, limit), relaxed: false });

  if (requestedRetrieval === "text") {
    const text = await keywordSearch(keywordQuery, CANDIDATE_POOL);
    return { retrieval: "text", rows: capPerVideo(filterDegenerate(text.rows)), keywordRelaxed: text.relaxed };
  }
  if (requestedRetrieval === "vector") {
    const rows = capPerVideo(filterDegenerate(await vectorResults(vectorQuery, CANDIDATE_POOL, openai, env)));
    return { retrieval: "vector", rows, keywordRelaxed: false };
  }

  const [vectorRaw, textRaw] = await Promise.all([
    vectorResults(vectorQuery, CANDIDATE_POOL, openai, env).catch(() => [] as RagSearchResult[]),
    keywordSearch(keywordQuery, CANDIDATE_POOL),
  ]);
  const vector = filterDegenerate(vectorRaw);
  const text = filterDegenerate(textRaw.rows);
  const keywordRelaxed = textRaw.relaxed;

  if (vector.length === 0) return { retrieval: "text", rows: capPerVideo(text), keywordRelaxed };
  if (text.length === 0) return { retrieval: "vector", rows: capPerVideo(vector), keywordRelaxed };
  return { retrieval: "hybrid", rows: capPerVideo(rrfFuse([vector, text])), keywordRelaxed };
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
