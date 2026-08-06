import { NextRequest, NextResponse } from "next/server";
import { openaiFor } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { capPerVideo, filterDegenerate } from "@/lib/ragRetrieval";
import { logSearch } from "@/lib/searchLogging";
import { createServerSupabase } from "@/lib/supabase";
import { refineResultTimestamps } from "@/lib/timestampRefinement";
import type { RagSearchResult } from "@/lib/types";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "12");
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 12;

  if (query.length < 2) {
    return NextResponse.json({ query, results: [], retrieval: "vector" });
  }

  const startedAt = performance.now();
  try {
    const env = getServerEnv();
    if (!env.openaiApiKey) {
      await logSearch({
        query,
        action: "semantic",
        retrieval: "vector",
        requestedRetrieval: "vector",
        outcome: {
          success: false,
          statusCode: 500,
          durationMs: performance.now() - startedAt,
          resultCount: 0,
          errorCode: "missing_openai_key",
        },
      });
      return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    const openai = openaiFor(env);
    const embedding = await openai.embeddings.create({
      model: env.ragEmbeddingModel,
      input: query,
    });

    const queryEmbedding = embedding.data[0]?.embedding;
    if (!queryEmbedding) {
      await logSearch({
        query,
        action: "semantic",
        retrieval: "vector",
        requestedRetrieval: "vector",
        outcome: {
          success: false,
          statusCode: 500,
          durationMs: performance.now() - startedAt,
          resultCount: 0,
          errorCode: "embedding_missing",
        },
      });
      return NextResponse.json({ error: "Embedding request returned no vector." }, { status: 500 });
    }

    const supabase = createServerSupabase();
    const { data, error } = await supabase.rpc("match_rag_transcript_chunks", {
      query_embedding: queryEmbedding,
      match_count: Math.min(limit * 3, 60),
      filter_video_id: null,
    });

    if (error) {
      await logSearch({
        query,
        action: "semantic",
        retrieval: "vector",
        requestedRetrieval: "vector",
        outcome: {
          success: false,
          statusCode: 500,
          durationMs: performance.now() - startedAt,
          resultCount: 0,
          errorCode: "database_search_failed",
        },
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const ranked = ((data ?? []) as RagSearchResult[]).map((result) => ({
      ...result,
      rank: result.similarity ?? result.rank ?? 0,
    }));
    const coarseResults = capPerVideo(filterDegenerate(ranked)).slice(0, limit);
    const results = await refineResultTimestamps(query, coarseResults);
    await logSearch({
      query,
      action: "semantic",
      retrieval: "vector",
      requestedRetrieval: "vector",
      outcome: {
        success: true,
        statusCode: 200,
        durationMs: performance.now() - startedAt,
        resultCount: results.length,
        model: env.ragEmbeddingModel,
      },
    });

    return NextResponse.json({
      query,
      retrieval: "vector",
      embedding_model: env.ragEmbeddingModel,
      results,
    });
  } catch (error) {
    await logSearch({
      query,
      action: "semantic",
      retrieval: "vector",
      requestedRetrieval: "vector",
      outcome: {
        success: false,
        statusCode: 500,
        durationMs: performance.now() - startedAt,
        resultCount: 0,
        errorCode: "semantic_search_failed",
      },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
