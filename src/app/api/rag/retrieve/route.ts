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
import { buildCandidates, metadataResults, rerankCandidates, uniqueRows } from "@/lib/ragPipeline";
import { capPerVideo, filterDegenerate, RERANK_POOL } from "@/lib/ragRetrieval";
import { logSearch } from "@/lib/searchLogging";
import { refineResultTimestamps } from "@/lib/timestampRefinement";

// Reranking narrows to RESULT_LIMIT (8) inside rerankCandidates, so asking for
// more than that yields nothing extra while rerank is on. The response reports
// what actually came back rather than quietly returning fewer than requested.
const MAX_LIMIT = 24;

// How many of the 12 rerank slots are reserved for technique-card hits.
//
// metadataResults searches the 3,432 structured cards on name, position, type
// and gi_nogi and maps matching time ranges back onto chunks. buildCandidates
// never calls it -- only instructorCompareGraph and retrievalSubgraph do -- so
// until now a query naming a technique got no benefit from the cards on this
// surface or on /api/rag/ask.
//
// Reserved rather than appended, because rerankCandidates takes
// candidates.slice(0, RERANK_POOL) and RERANK_POOL is 12. Appending metadata
// hits to a candidate list that already holds 12 rows would drop every one of
// them before the rerank ever saw them: a change that reads as working and
// does nothing.
//
// DEFAULT OFF. The card path is wired up, measured, and found to make results
// WORSE, so it ships behind include_metadata: true rather than on.
//
// PLAN.md Tier 2 said card quality "steers which chunks retrieval returns" and
// treated metadataResults never being called by buildCandidates as a defect.
// Wiring it in and measuring says otherwise. Deterministic A/B on the running
// pipeline, 2026-08-28, with an OFF-twice stability control proving the
// differences are real and not rerank noise:
//
//   escaping side control  pushes "How To Do The Perfect BJJ Side Control
//                          Escape by John Danaher" off #1 entirely, and puts an
//                          untitled "Instagram Reel" at #4
//   heel hook defense      displaces Eddie Cummings on inside sankaku with WNO
//                          event footage, which the content_kind gate then has
//                          to remove
//   berimbolo              no effect: one query term cannot reach the score
//                          threshold, so the cards never fire
//   half guard knee shield a neutral shuffle of slots 4 and 5
//
// Reserved slots are displacement: every card hit costs a retrieval hit that
// the rerank had already ranked above it. The cards are good at describing a
// technique and bad at deciding which chunk answers a question, and FTS plus
// embeddings had already found the better chunk.
//
// Kept rather than reverted so the next person reads the measurement instead of
// re-deriving it, and so a better merge strategy has somewhere to start.
const METADATA_SLOTS = 2;

// metadataResults ranks a chunk by how many query terms matched the technique
// card (name, position, type, gi_nogi). A one-term match is noise: "sweep"
// alone matches hundreds of cards and tells the pool nothing it did not already
// know from FTS. Two or more terms -- "de la riva" AND "sweep" -- is the case
// the structured cards actually answer better than text search.
const MIN_METADATA_SCORE = 2;

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

    // OFF by default, because it was measured and it is worse. See
    // METADATA_SLOTS above. Opt in with include_metadata: true.
    const includeMetadata = body.include_metadata === true;

    const [{ retrieval, rows }, metadataRaw] = await Promise.all([
      buildCandidates(query, openai ? requestedRetrieval : "text", openai, env),
      // Never let the card path break retrieval: it is an enrichment, and a
      // failure here must degrade to the behaviour that existed before it.
      includeMetadata
        ? metadataResults(query, METADATA_SLOTS * 2).catch(() => [])
        : Promise.resolve([]),
    ]);

    const primary = capPerVideo(filterDegenerate(uniqueRows(rows)));
    const metadataHits = capPerVideo(
      filterDegenerate(uniqueRows(metadataRaw.filter((row) => (row.rank ?? 0) >= MIN_METADATA_SCORE))),
    );

    // Diversity and degenerate filtering are applied per source before merging,
    // so capPerVideo cannot quietly discard the reserved card hits while
    // trimming a run of chunks from one long video.
    const reserved = Math.min(METADATA_SLOTS, metadataHits.length);
    const head = primary.slice(0, Math.max(0, RERANK_POOL - reserved));
    const candidates = uniqueRows([
      ...head,
      ...metadataHits.slice(0, reserved),
      ...primary.slice(head.length),
    ]);
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
      // Whether the technique-card path contributed, and how much. Without it a
      // caller cannot tell "the cards added nothing" from "the cards never ran",
      // which are different claims about the same result set.
      metadata_candidates: reserved,
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
