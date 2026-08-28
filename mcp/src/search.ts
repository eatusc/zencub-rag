// Retrieval for the MCP server, over the app's own HTTP endpoints.
//
// Deliberately not an in-process import of src/lib/ragPipeline. That works
// (see mcp/scripts/spike-retrieval-import.ts) but every retrieval function
// reaches the database through createServerSupabase(), which is built from
// SUPABASE_SERVICE_ROLE_KEY: full read and write on all 61 tables, RLS
// bypassed. Calling over HTTP keeps that credential inside the Next process
// and leaves this server holding nothing but zencub_mcp_reader.
//
// The split is therefore: HTTP ranks, the reader role supplies corpus facts.

export type RetrievalHit = {
  id: string;
  video_id: string;
  chunk_index: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
  rank?: number;
  similarity?: number;
  metadata?: Record<string, unknown> | null;
};

export type SearchMode = "text" | "semantic" | "both";

/** The app's real pipeline, on the loopback-only APP_MODE=mcp build. */
const RETRIEVE_ENDPOINT = "/api/rag/retrieve";

/**
 * Defaults to the MCP surface on 3421, not the public site on 3418.
 *
 * Pointing at 3418 would work for the two single-mode endpoints and is what
 * this did originally, but it is the wrong host on purpose now: /api/rag/ask
 * spends search.zencub.com's daily answer budget in middleware before the
 * handler runs, and every call to the two search routes writes a row into
 * rag_search_logs tagged as ordinary site traffic.
 */
export function retrievalBaseUrl(): string {
  return (process.env.MCP_RETRIEVAL_BASE_URL ?? "http://127.0.0.1:3421").replace(/\/+$/, "");
}

// There is deliberately no fusion function here any more.
//
// This file used to RRF the two single-mode endpoints together. With two
// disjoint ten-item lists, rank i in either list scores identically at
// 1/(k+i+1), so every position was a two-way tie; JavaScript's sort is stable
// and the text list was passed first, so keyword won every tie and the output
// was a zipper -- text, vector, text, vector -- rather than a ranking. Measured
// across eight queries on 2026-08-28 the alternation was exact, which is what
// proved it was tie-breaking and not relevance.
//
// The fix was not a better constant. It was to stop ranking here at all. The
// app already fuses, reranks, diversifies and refines timestamps in one place,
// and now this calls it. If a second fusion ever reappears in this file, the
// two surfaces have started to diverge again, which is the thing the Phase 2
// decision was supposed to prevent and did not.

/**
 * The app's own retrieval, stopping short of answer generation.
 *
 * This is the whole point of the MCP surface: buildCandidates fuses vector and
 * text with the app's RRF, rerankCandidates reorders by actual relevance,
 * capPerVideo keeps one video from taking every slot, and refineResultTimestamps
 * moves each hit to the moment the thing is said. None of that was reachable
 * through the two single-mode endpoints.
 */
async function retrieveViaPipeline(
  query: string,
  limit: number,
  timeoutMs: number,
  retrieval?: "text" | "vector",
): Promise<{ hits: RetrievalHit[]; warnings: string[]; meta: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${retrievalBaseUrl()}${RETRIEVE_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit, ...(retrieval ? { retrieval } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 404 here almost always means the base URL points at the public or
      // instructors build, which do not expose this route. Say that, rather
      // than letting it read as "the corpus had nothing".
      const hint = response.status === 404
        ? ` -- ${retrievalBaseUrl()} does not serve ${RETRIEVE_ENDPOINT}. Is the APP_MODE=mcp build running on this port?`
        : "";
      return { hits: [], warnings: [`retrieval returned HTTP ${response.status}${hint}`], meta: {} };
    }
    const body = await response.json() as {
      results?: RetrievalHit[];
      retrieval?: string;
      reranked?: boolean;
      degraded?: string;
      error?: string;
    };
    if (body.error) return { hits: [], warnings: [`retrieval: ${body.error}`], meta: {} };
    const warnings: string[] = [];
    if (body.degraded) warnings.push(body.degraded);
    const hits = body.results ?? [];
    // Reranking narrows to the app's RESULT_LIMIT before this route slices, so
    // a large limit cannot be satisfied. Disclose it rather than returning
    // fewer results than asked for with no explanation.
    if (hits.length < limit) {
      warnings.push(
        `Returned ${hits.length} of ${limit} requested. The app's rerank narrows the pool to its own result limit, so asking for more does not widen it.`,
      );
    }
    return {
      hits,
      warnings,
      meta: { retrieval_mode: body.retrieval ?? "unknown", reranked: body.reranked ?? false },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      hits: [],
      warnings: [`retrieval unreachable at ${retrievalBaseUrl()}: ${detail}`],
      meta: {},
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function retrieve(
  mode: SearchMode,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<{ hits: RetrievalHit[]; warnings: string[]; meta: Record<string, unknown> }> {
  // Every mode now goes through the app's pipeline. "text" and "semantic" pin
  // the retrieval side but still get the rerank, the diversity cap and the
  // timestamp refinement, which the raw single-mode endpoints never applied.
  if (mode === "both") return retrieveViaPipeline(query, limit, timeoutMs);
  return retrieveViaPipeline(query, limit, timeoutMs, mode === "semantic" ? "vector" : "text");
}

// ── deep links ──────────────────────────────────────────────────────────────

export type LinkPrecision = "timestamp" | "video_only" | "unavailable";

/**
 * Build a link that lands the viewer at the moment, and say honestly when it
 * cannot. A timestamp link that silently opens at 0:00 is the same failure as
 * an empty result set that should have had rows: well formed and wrong.
 */
export function deepLink(
  videoUrl: string | null | undefined,
  platform: string | null | undefined,
  startSeconds: number,
): { deep_link: string | null; deep_link_precision: LinkPrecision } {
  if (!videoUrl || videoUrl.startsWith("local:")) {
    return { deep_link: null, deep_link_precision: "unavailable" };
  }
  if (platform === "youtube") {
    const seconds = Math.max(0, Math.floor(startSeconds));
    // /shorts/ URLs ignore &t=, so rewrite to the watch form, which honours it.
    const shorts = videoUrl.match(/youtube\.com\/shorts\/([\w-]+)/);
    const base = shorts ? `https://www.youtube.com/watch?v=${shorts[1]}` : videoUrl;
    const separator = base.includes("?") ? "&" : "?";
    return { deep_link: `${base}${separator}t=${seconds}s`, deep_link_precision: "timestamp" };
  }
  // TikTok and Instagram have no reliable timestamp fragment.
  return { deep_link: videoUrl, deep_link_precision: "video_only" };
}
