import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { generateAnswer, probeQwen, providerModel } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { normalizeProvider, type AnswerProvider } from "@/lib/providers";
import {
  CANDIDATE_POOL,
  RERANK_POOL,
  capPerVideo,
  enrichWithTechniques,
  filterDegenerate,
  rerankWithLLM,
  rrfFuse,
} from "@/lib/ragRetrieval";
import { formatRagSource } from "@/lib/ragUtils";
import { logSearch } from "@/lib/searchLogging";
import { createServerSupabase } from "@/lib/supabase";
import { refineResultTimestamps } from "@/lib/timestampRefinement";
import type { RagConversationTurn, RagSearchResult } from "@/lib/types";

const RESULT_LIMIT = 8;
type RetrievalMode = "vector" | "text" | "hybrid";

async function vectorResults(query: string, limit: number, openai: OpenAI | null, env: ReturnType<typeof getServerEnv>) {
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

async function contextResults(ids: string[]) {
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

function normalizeConversation(value: unknown): RagConversationTurn[] {
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

function normalizeContextIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 12);
}

function uniqueRows(rows: RagSearchResult[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

// Retrieve candidates, fuse with RRF, then diversify. Replaces the previous
// similarity-threshold + interleave + citation-retry logic with rank fusion,
// which needs no score cutoff and merges text and vector on equal footing.
async function buildCandidates(
  query: string,
  requestedRetrieval: "text" | "vector" | "auto",
  openai: OpenAI | null,
  env: ReturnType<typeof getServerEnv>,
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

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as {
    query?: unknown;
    retrieval?: unknown;
    provider?: unknown;
    conversation?: unknown;
    context_ids?: unknown;
  };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedRetrieval = body.retrieval === "text" || body.retrieval === "vector" ? body.retrieval : "auto";
  const requestedProvider = normalizeProvider(body.provider);
  const conversation = normalizeConversation(body.conversation);
  const contextIds = normalizeContextIds(body.context_ids);

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }
  if (query.length > 1_000) {
    return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });
  }

  await logSearch({
    query,
    action: conversation.length > 0 ? "follow_up" : "ask",
    provider: requestedProvider,
    retrieval: requestedRetrieval,
    metadata: {
      conversation_turns: conversation.length,
      retained_context_sources: contextIds.length,
    },
  });

  try {
    const env = getServerEnv();
    const hasOpenai = Boolean(env.openaiApiKey);
    const hasOpenRouter = Boolean(env.openRouterApiKey);

    // Resolve the answer provider: honor an explicit request, otherwise default
    // to the local Qwen model when it's reachable (the Mac Studio), else OpenAI.
    let provider: AnswerProvider = requestedProvider
      ?? ((await probeQwen(env)) ? "qwen" : hasOpenRouter ? "openrouter" : "openai");
    if (provider === "openrouter" && !hasOpenRouter) {
      return NextResponse.json({ error: "Missing OPENROUTER_API_KEY." }, { status: 500 });
    }
    if (provider === "openai" && !hasOpenai) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    // Retrieval (embeddings + rerank) always runs on OpenAI; the provider choice
    // only swaps the model that writes the final answer. Without an OpenAI key we
    // degrade to text-only search and skip reranking so local providers still work.
    const openai = hasOpenai ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
    const retrievalQuery = conversation.length > 0
      ? [...conversation.map((turn) => turn.question), query].join(" | ").slice(0, 2_000)
      : query;
    const [{ retrieval, rows }, priorRows] = await Promise.all([
      buildCandidates(retrievalQuery, openai ? requestedRetrieval : "text", openai, env),
      contextResults(contextIds),
    ]);
    const candidates = capPerVideo(filterDegenerate(uniqueRows([...priorRows, ...rows])));

    if (candidates.length === 0) {
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    // Rerank the diverse candidate pool for true relevance, keep the top slice,
    // then enrich with overlapping technique metadata for grounded citations.
    const pool = candidates.slice(0, RERANK_POOL);
    const didRerank = Boolean(openai && env.ragRerankEnabled);
    const reranked = openai && env.ragRerankEnabled
      ? await rerankWithLLM(retrievalQuery, pool, openai, env.ragRerankModel, RESULT_LIMIT)
      : pool;
    const top = await refineResultTimestamps(query, reranked.slice(0, RESULT_LIMIT));
    const enriched = await enrichWithTechniques(top);
    const sources = enriched.map(({ row, technique }, index) => formatRagSource(row, index, technique));

    let generation;
    try {
      generation = await generateAnswer(provider, query, sources, env, openai, conversation);
    } catch (genError) {
      // Follow the answer-engine order for a transparent server-side fallback.
      const fallback: AnswerProvider | null = provider !== "openrouter" && hasOpenRouter
        ? "openrouter"
        : provider !== "openai" && hasOpenai
          ? "openai"
          : null;
      if (fallback) {
        provider = fallback;
        generation = await generateAnswer(fallback, query, sources, env, openai, conversation);
      } else {
        throw genError;
      }
    }

    return NextResponse.json({
      query,
      provider,
      model: providerModel(provider, env),
      retrieval,
      reranked: didRerank,
      source_count: sources.length,
      context_ids: top.map((row) => row.id),
      usage: generation.usage,
      answer: generation.answer,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
