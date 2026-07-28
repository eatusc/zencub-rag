// Which surface this process serves. One codebase, two deployments:
//
//   public -> search.zencub.com : transcript search only (text, semantic, ask)
//   full   -> demo.zencub.com   : every tab, PIN gated
//
// APP_MODE is read at build time (Next inlines it into the middleware bundle),
// so each deployment gets its own build directory. See scripts/deploy/build.sh.

export type AppMode = "public" | "full";

export function getAppMode(): AppMode {
  return process.env.APP_MODE === "public" ? "public" : "full";
}

export function isPublicMode(): boolean {
  return getAppMode() === "public";
}

// The only API routes the public deployment exposes. Everything else under
// /api answers 404 so the LangGraph, Instructor Compare, and Langfuse routes
// are unreachable rather than merely hidden from the UI.
export const PUBLIC_API_ROUTES = [
  "/api/health",
  "/api/rag/search",
  "/api/rag/vector-search",
  "/api/rag/ask",
] as const;

export function isPublicApiRoute(pathname: string): boolean {
  return PUBLIC_API_ROUTES.some((route) => pathname === route);
}

// Which model answers on the public site. Local Qwen is free but takes about
// 45 seconds per answer; OpenRouter returns in under 10 at roughly $0.001 a
// call. Set RAG_PUBLIC_ASK_PROVIDER to pick; unset falls back to the normal
// detection chain, which prefers local Qwen.
export function publicAskProvider(): string | undefined {
  const configured = process.env.RAG_PUBLIC_ASK_PROVIDER?.trim();
  return configured ? configured : undefined;
}
