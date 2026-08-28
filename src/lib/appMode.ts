// Which surface this process serves. One codebase, four deployments:
//
//   public      -> search.zencub.com      : transcript search only (text, semantic, ask)
//   instructors -> instructors.zencub.com : the Instructor Compare workflow
//   full        -> demo.zencub.com        : every tab, PIN gated
//   mcp         -> 127.0.0.1 only         : retrieval for the MCP server, never tunnelled
//
// APP_MODE is read at build time (Next inlines it into the middleware bundle),
// so each deployment gets its own build directory. See scripts/deploy/build.sh.

import type { AnswerProvider } from "@/lib/providers";

export type AppMode = "public" | "instructors" | "full" | "mcp";

export function getAppMode(): AppMode {
  if (process.env.APP_MODE === "public") return "public";
  if (process.env.APP_MODE === "instructors") return "instructors";
  if (process.env.APP_MODE === "mcp") return "mcp";
  return "full";
}

export function isPublicMode(): boolean {
  return getAppMode() === "public";
}

// The only API routes the public search deployment exposes. Everything else
// under /api answers 404 so the LangGraph, Instructor Compare, and Langfuse
// routes are unreachable rather than merely hidden from the UI.
export const PUBLIC_API_ROUTES = [
  "/api/health",
  "/api/rag/search",
  "/api/rag/vector-search",
  "/api/rag/ask",
] as const;

export function isPublicApiRoute(pathname: string): boolean {
  return PUBLIC_API_ROUTES.some((route) => pathname === route);
}

// The instructors deployment runs one workflow and nothing else. In particular
// it does not expose /api/rag/instructor-compare, the demo's route, which takes
// a caller-chosen provider and a test-mode failure slug.
export const INSTRUCTORS_API_ROUTES = [
  "/api/health",
  "/api/instructors/compare",
  "/api/instructors/runs",
] as const;

export function isInstructorsApiRoute(pathname: string): boolean {
  return INSTRUCTORS_API_ROUTES.some((route) => pathname === route);
}

// Page paths the instructors deployment serves. Anything else redirects home,
// so the surface stays the landing page plus its permalinks.
export function isInstructorsPagePath(pathname: string): boolean {
  return pathname === "/" || /^\/c\/[0-9a-f-]{36}$/i.test(pathname);
}

// The MCP surface exists so the MCP server can reach the real retrieval
// pipeline -- buildCandidates, rerankCandidates, the technique-card path --
// without any of it appearing on a tunnelled host.
//
// It is a separate deployment rather than a route on the public one for two
// reasons, both measured rather than assumed:
//
//   1. /api/rag/ask cannot be reused. The site-wide daily answer budget is
//      consumed in middleware keyed on that pathname, before the handler ever
//      reads the body, so no request flag can opt out of it. Retrieval calls
//      would spend search.zencub.com's Ask allowance and eventually show real
//      users "Ask AI has hit its daily limit".
//   2. Retrieval is not free: an embedding call plus a rerank per request.
//      Publishing that on a tunnelled host would be an uncapped spend path,
//      and clientIp() reads caller-supplied headers, so it cannot be cheaply
//      restricted to loopback at the application layer.
//
// This build is served on loopback with no Cloudflare Tunnel in front of it.
// That, not a header check, is what keeps it private.
export const MCP_API_ROUTES = [
  "/api/health",
  "/api/rag/retrieve",
] as const;

export function isMcpApiRoute(pathname: string): boolean {
  return MCP_API_ROUTES.some((route) => pathname === route);
}

// Which model answers on the public search site. Local Qwen is free but takes
// about 45 seconds per answer; OpenRouter returns in under 10 at roughly $0.001
// a call. Set RAG_PUBLIC_ASK_PROVIDER to pick; unset falls back to the normal
// detection chain, which prefers local Qwen.
export function publicAskProvider(): string | undefined {
  const configured = process.env.RAG_PUBLIC_ASK_PROVIDER?.trim();
  return configured ? configured : undefined;
}

// Which model runs the public comparison workflow. Pinned server-side and never
// taken from the request: a comparison is a dozen model calls, and local Qwen
// would hold the machine's only Ollama instance for about ten minutes per run.
export function publicInstructorsProvider(): Exclude<AnswerProvider, "claude"> {
  const configured = process.env.RAG_INSTRUCTORS_PROVIDER?.trim();
  if (configured === "openrouter" || configured === "qwen") return configured;
  return "openai";
}

// How many instructors the public panel asks for. Five rather than three
// because the corpus turned out to support it: measured across three topics,
// every panel filled completely, quality scored 100% on all of them against 67%
// on a three-instructor run of the same question, and evidence rose from 4-6
// clips to 6-8. Latency did not move, because the analysis branches fan out in
// parallel, so a wider panel costs two more concurrent calls rather than two
// more sequential ones. The graph clamps to 2-5.
export function publicInstructorsPanelSize(): number {
  const configured = Number(process.env.RAG_INSTRUCTORS_PANEL_SIZE);
  if (!Number.isInteger(configured)) return 5;
  return Math.min(Math.max(configured, 2), 5);
}
