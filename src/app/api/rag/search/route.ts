import { NextRequest, NextResponse } from "next/server";
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
    return NextResponse.json({ query, results: [] });
  }

  const startedAt = performance.now();
  try {
    const supabase = createServerSupabase();
    // Over-fetch so degenerate-filtering and per-video diversity still leave
    // a full page of results.
    const { data, error } = await supabase.rpc("search_rag_transcript_chunks", {
      query_text: query,
      match_count: Math.min(limit * 3, 60),
    });

    if (error) {
      await logSearch({
        query,
        action: "keyword",
        retrieval: "text",
        requestedRetrieval: "text",
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

    const coarseResults = capPerVideo(filterDegenerate((data ?? []) as RagSearchResult[])).slice(0, limit);
    const results = await refineResultTimestamps(query, coarseResults);
    await logSearch({
      query,
      action: "keyword",
      retrieval: "text",
      requestedRetrieval: "text",
      outcome: {
        success: true,
        statusCode: 200,
        durationMs: performance.now() - startedAt,
        resultCount: results.length,
      },
    });

    return NextResponse.json({
      query,
      results,
    });
  } catch (error) {
    await logSearch({
      query,
      action: "keyword",
      retrieval: "text",
      requestedRetrieval: "text",
      outcome: {
        success: false,
        statusCode: 500,
        durationMs: performance.now() - startedAt,
        resultCount: 0,
        errorCode: "search_failed",
      },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
