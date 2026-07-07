import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getServerEnv } from "@/lib/env";
import { asNumber, formatRagSource } from "@/lib/ragUtils";
import { createServerSupabase } from "@/lib/supabase";
import type { RagAnswer, RagSearchResult } from "@/lib/types";

const RESULT_LIMIT = 8;
const MIN_VECTOR_RESULTS = 3;
const MIN_VECTOR_TOP_SIMILARITY = 0.5;

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
    let retrieval: "vector" | "text" = "text";
    let rows: RagSearchResult[] = [];

    if (requestedRetrieval !== "text") {
      rows = await vectorResults(query, RESULT_LIMIT, openai, env);
      retrieval = "vector";
    }

    const topVectorSimilarity = rows[0]?.similarity ?? rows[0]?.rank ?? 0;
    const shouldFallbackToText = requestedRetrieval === "auto"
      && (rows.length < MIN_VECTOR_RESULTS || topVectorSimilarity < MIN_VECTOR_TOP_SIMILARITY);

    if (requestedRetrieval === "text" || shouldFallbackToText) {
      rows = await textResults(query, RESULT_LIMIT);
      retrieval = "text";
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    const sources = rows.map(formatRagSource);
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
            "If evidence is weak, say so in caveats.",
            "Return valid JSON only with keys: answer, citations, key_takeaways, follow_up_searches, caveats.",
            "citations must be copied from provided sources and include title, citation, start_seconds, end_seconds, watch_url.",
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
    const answer = coerceAnswer(parsed);

    return NextResponse.json({
      query,
      model: env.ragAnswerModel,
      retrieval,
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
