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

const ENDPOINTS: Record<Exclude<SearchMode, "both">, string> = {
  text: "/api/rag/search",
  semantic: "/api/rag/vector-search",
};

export function retrievalBaseUrl(): string {
  return (process.env.MCP_RETRIEVAL_BASE_URL ?? "http://127.0.0.1:3418").replace(/\/+$/, "");
}

async function callEndpoint(
  mode: Exclude<SearchMode, "both">,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<{ hits: RetrievalHit[]; error?: string }> {
  const url = `${retrievalBaseUrl()}${ENDPOINTS[mode]}?q=${encodeURIComponent(query)}&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { hits: [], error: `${mode} search returned HTTP ${response.status}` };
    }
    const body = (await response.json()) as { results?: RetrievalHit[]; error?: string };
    if (body.error) return { hits: [], error: `${mode} search: ${body.error}` };
    return { hits: body.results ?? [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The app runs under launchd on this host. If it is down, say so plainly
    // rather than returning an empty result set that reads like "no matches".
    return { hits: [], error: `${mode} search unreachable at ${retrievalBaseUrl()}: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reciprocal rank fusion across the two modes.
 *
 * The app blends its own retrieval internally; this only merges the two
 * endpoints, which return independently ranked lists. k=60 is the usual
 * constant and only affects how sharply early ranks dominate.
 */
export function fuse(lists: RetrievalHit[][], k = 60): RetrievalHit[] {
  const scores = new Map<string, { hit: RetrievalHit; score: number; modes: number }>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = hit.id;
      const entry = scores.get(key);
      const contribution = 1 / (k + index + 1);
      if (entry) {
        entry.score += contribution;
        entry.modes += 1;
      } else {
        scores.set(key, { hit, score: contribution, modes: 1 });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.hit);
}

export async function retrieve(
  mode: SearchMode,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<{ hits: RetrievalHit[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (mode !== "both") {
    const { hits, error } = await callEndpoint(mode, query, limit, timeoutMs);
    if (error) warnings.push(error);
    return { hits, warnings };
  }
  const [text, semantic] = await Promise.all([
    callEndpoint("text", query, limit, timeoutMs),
    callEndpoint("semantic", query, limit, timeoutMs),
  ]);
  if (text.error) warnings.push(text.error);
  if (semantic.error) warnings.push(semantic.error);
  // Semantic needs OPENAI_API_KEY. Degrading to text alone is fine, but the
  // caller has to be told, or it will read a thinner result set as the corpus
  // having less to say.
  if (semantic.error && text.hits.length > 0) {
    warnings.push("Degraded to text-only retrieval. Results are keyword matches, not semantic.");
  }
  return { hits: fuse([text.hits, semantic.hits]), warnings };
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
