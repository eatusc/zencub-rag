// Retrieval without generation, for the MCP server.
//
// This exists because the MCP server was doing its own fusion over
// /api/rag/search and /api/rag/vector-search, which are single-mode endpoints:
// FTS only and vector only. Fusing them again in a second place produced a
// zipper rather than a ranking -- with two disjoint ten-item lists, plain RRF
// ties every rank, and a stable sort handed keyword the top slot every time.
// It also meant the server missed reranking, cross-mode diversity and
// timestamp refinement entirely.
//
// So this route calls the same pipeline /api/rag/ask calls, and stops before
// generateAnswer. It imports buildCandidates and rerankCandidates rather than
// reimplementing them, and modifies neither: instructors.zencub.com reaches
// those same functions through instructorCompareGraph, so a change to the
// library would land in the comparison workflow. The route layer is the only
// safe place to add this.
//
// Why it is not a flag on /api/rag/ask: the site-wide daily answer budget is
// consumed in middleware keyed on that pathname, before the handler reads the
// body, so no request flag can opt out. Retrieval calls would spend
// search.zencub.com's Ask allowance and eventually tell real users that
// "Ask AI has hit its daily limit".
//
// Served only on the loopback-only APP_MODE=mcp build. The public and
// instructors builds answer 404 here; see MCP_API_ROUTES in src/lib/appMode.ts.

import { NextRequest, NextResponse } from "next/server";
import { openaiFor } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { buildCandidates, rerankCandidates, uniqueRows } from "@/lib/ragPipeline";
import { capPerVideo, filterDegenerate } from "@/lib/ragRetrieval";
import { logSearch } from "@/lib/searchLogging";
import { refineResultTimestamps } from "@/lib/timestampRefinement";

// Reranking narrows to RESULT_LIMIT (8) inside rerankCandidates, so asking for
// more than that yields nothing extra while rerank is on. The response reports
// what actually came back rather than quietly returning fewer than requested.
const MAX_LIMIT = 24;

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedRetrieval =
    body.retrieval === "text" || body.retrieval === "vector" ? body.retrieval : "auto";
  const requestedLimit = Number(body.limit ?? 12);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT)
    : 12;

  if (query.length < 2) {
    return NextResponse.json({ query, results: [], retrieval: "none" });
  }

  try {
    const env = getServerEnv();
    // Retrieval runs on OpenAI. Without a key, degrade to text and skip the
    // rerank rather than failing: the caller is told which happened.
    const openai = env.openaiApiKey ? openaiFor(env) : null;

    const { retrieval, rows } = await buildCandidates(
      query,
      openai ? requestedRetrieval : "text",
      openai,
      env,
    );
    const candidates = capPerVideo(filterDegenerate(uniqueRows(rows)));
    // buildCandidates can report "metadata", which rag_search_logs.retrieval
    // does not accept (auto | text | vector | hybrid). /api/rag/ask maps it the
    // same way; do not invent a fifth value here, the CHECK would reject it.
    const loggedRetrieval = retrieval === "metadata" ? "hybrid" : retrieval;

    if (candidates.length === 0) {
      await logSearch({
        query,
        action: "mcp",
        retrieval: loggedRetrieval,
        requestedRetrieval,
        outcome: {
          success: true,
          statusCode: 200,
          durationMs: performance.now() - startedAt,
          resultCount: 0,
        },
      });
      return NextResponse.json({ query, retrieval, reranked: false, results: [] });
    }

    const { reranked, didRerank } = await rerankCandidates(query, candidates, openai, env);
    const results = await refineResultTimestamps(query, reranked.slice(0, limit));

    await logSearch({
      query,
      action: "mcp",
      retrieval: loggedRetrieval,
      requestedRetrieval,
      outcome: {
        success: true,
        statusCode: 200,
        durationMs: performance.now() - startedAt,
        resultCount: results.length,
      },
    });

    return NextResponse.json({
      query,
      // What actually ran, not what was asked for. "hybrid" means both modes
      // contributed and were fused by the app's own RRF, not by the caller.
      retrieval,
      reranked: didRerank,
      degraded: openai ? undefined : "No OPENAI_API_KEY: text-only retrieval, no rerank.",
      requested_limit: limit,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retrieval failed";
    await logSearch({
      query,
      action: "mcp",
      requestedRetrieval,
      outcome: {
        success: false,
        statusCode: 500,
        durationMs: performance.now() - startedAt,
        resultCount: 0,
        errorCode: "retrieve_failed",
      },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
