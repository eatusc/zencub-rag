import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getServerEnv } from "@/lib/env";
import {
  CANDIDATE_POOL,
  RERANK_POOL,
  capPerVideo,
  enrichWithTechniques,
  filterDegenerate,
  rerankWithLLM,
  rrfFuse,
} from "@/lib/ragRetrieval";
import { asNumber, formatRagSource, type RagSource } from "@/lib/ragUtils";
import { createServerSupabase } from "@/lib/supabase";
import { refineResultTimestamps } from "@/lib/timestampRefinement";
import type { RagAnswer, RagSearchResult } from "@/lib/types";

const RESULT_LIMIT = 8;
type RetrievalMode = "vector" | "text" | "hybrid";

function coerceAnswer(value: unknown): RagAnswer {
  const fallback: RagAnswer = {
    answer: "No answer returned.",
    citations: [],
    key_takeaways: [],
    follow_up_searches: [],
    caveats: ["The model did not return the expected JSON shape."],
  };

  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;

  return {
    answer: typeof raw.answer === "string" ? raw.answer : fallback.answer,
    citations: Array.isArray(raw.citations) ? raw.citations.slice(0, 8).map((citation) => {
      const item = citation && typeof citation === "object" ? citation as Record<string, unknown> : {};
      return {
        title: typeof item.title === "string" ? item.title : "Untitled source",
        citation: typeof item.citation === "string" ? item.citation : "No citation",
        start_seconds: asNumber(item.start_seconds as number | string | null | undefined),
        end_seconds: asNumber(item.end_seconds as number | string | null | undefined),
        watch_url: typeof item.watch_url === "string" ? item.watch_url : null,
      };
    }) : [],
    key_takeaways: Array.isArray(raw.key_takeaways) ? raw.key_takeaways.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    follow_up_searches: Array.isArray(raw.follow_up_searches) ? raw.follow_up_searches.filter((item): item is string => typeof item === "string").slice(0, 6) : [],
    caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((item): item is string => typeof item === "string").slice(0, 4) : [],
  };
}

async function vectorResults(query: string, limit: number, openai: OpenAI, env: ReturnType<typeof getServerEnv>) {
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

// Retrieve candidates, fuse with RRF, then diversify. Replaces the previous
// similarity-threshold + interleave + citation-retry logic with rank fusion,
// which needs no score cutoff and merges text and vector on equal footing.
async function buildCandidates(
  query: string,
  requestedRetrieval: "text" | "vector" | "auto",
  openai: OpenAI,
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

async function generateAnswer(query: string, sources: RagSource[], openai: OpenAI, env: ReturnType<typeof getServerEnv>) {
  const completion = await openai.chat.completions.create({
    model: env.ragAnswerModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a concise BJJ research assistant.",
          "Answer only from the provided transcript chunks.",
          "Do not invent techniques, videos, timestamps, or claims.",
          "Each source may include technique, position, difficulty, and gi_nogi tags; use them to frame the answer accurately.",
          "If evidence is weak, say so in caveats.",
          "Return valid JSON only with keys: answer, citations, key_takeaways, follow_up_searches, caveats.",
          "citations must be copied from provided sources and include title, citation, start_seconds, end_seconds, watch_url.",
          "If any source supports the answer, include at least one citation.",
          "Prefer citing 2 or more distinct videos when multiple sources support the answer, rather than repeating one video at different timestamps.",
          "Use short paragraphs and practical jiu-jitsu language.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          query,
          task: "Answer the question using only these retrieved transcript chunks.",
          sources,
        }),
      },
    ],
  });

  const content = completion.choices[0]?.message.content ?? "{}";
  const parsed = JSON.parse(content) as unknown;
  return coerceAnswer(parsed);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { query?: unknown; retrieval?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedRetrieval = body.retrieval === "text" || body.retrieval === "vector" ? body.retrieval : "auto";

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }

  try {
    const env = getServerEnv();
    if (!env.openaiApiKey) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey: env.openaiApiKey });
    const { retrieval, rows } = await buildCandidates(query, requestedRetrieval, openai, env);

    if (rows.length === 0) {
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    // Rerank the diverse candidate pool for true relevance, keep the top slice,
    // then enrich with overlapping technique metadata for grounded citations.
    const pool = rows.slice(0, RERANK_POOL);
    const reranked = env.ragRerankEnabled
      ? await rerankWithLLM(query, pool, openai, env.ragRerankModel, RESULT_LIMIT)
      : pool;
    const top = await refineResultTimestamps(query, reranked.slice(0, RESULT_LIMIT));
    const enriched = await enrichWithTechniques(top);
    const sources = enriched.map(({ row, technique }, index) => formatRagSource(row, index, technique));

    const answer = await generateAnswer(query, sources, openai, env);

    return NextResponse.json({
      query,
      model: env.ragAnswerModel,
      retrieval,
      reranked: env.ragRerankEnabled,
      source_count: sources.length,
      answer,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
