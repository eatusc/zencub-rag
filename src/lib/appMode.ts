// Which surface this process serves. One codebase, three deployments:
//
//   public      -> search.zencub.com      : transcript search only (text, semantic, ask)
//   instructors -> instructors.zencub.com : the Instructor Compare workflow
//   full        -> demo.zencub.com        : every tab, PIN gated
//
// APP_MODE is read at build time (Next inlines it into the middleware bundle),
// so each deployment gets its own build directory. See scripts/deploy/build.sh.

import type { AnswerProvider } from "@/lib/providers";

export type AppMode = "public" | "instructors" | "full";

export function getAppMode(): AppMode {
  if (process.env.APP_MODE === "public") return "public";
  if (process.env.APP_MODE === "instructors") return "instructors";
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
