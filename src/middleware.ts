import { NextResponse, type NextRequest } from "next/server";
import {
  getAppMode,
  isInstructorsApiRoute,
  isInstructorsPagePath,
  isPublicApiRoute,
} from "@/lib/appMode";
import { DEMO_COOKIE, demoCredentials, verifyDemoCookie } from "@/lib/demoAuth";
import {
  checkRateLimit,
  clientIp,
  consumeDailyAskBudget,
  consumeDailyCompareBudget,
  type LimitName,
} from "@/lib/rateLimit";

// APP_MODE is inlined at build time, so each deployment builds its own bundle
// and this branch is decided once rather than per request.
const MODE = getAppMode();

const UNLOCK_PATHS = new Set(["/unlock", "/api/unlock"]);

// Workflow routes on the demo surface. Each of these runs a LangGraph workflow
// worth many model calls, and none of them were metered before: the PIN was the
// only thing between a shared demo link and unbounded spend.
const WORKFLOW_PATHS = new Set([
  "/api/rag/instructor-compare",
  "/api/rag/graph-ask",
  "/api/rag/graph-follow-up",
]);

function rateLimitFor(pathname: string): LimitName | null {
  if (pathname === "/api/rag/ask") return "ask";
  if (pathname === "/api/rag/search" || pathname === "/api/rag/vector-search") return "search";
  return null;
}

function tooManyRequests(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Rate limit exceeded. Please wait a moment and try again." },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );
}

function publicMiddleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Everything under /api that is not on the allowlist answers 404, so the
  // LangGraph, Instructor Compare, and Langfuse routes are unreachable here
  // rather than just hidden from the UI.
  if (pathname.startsWith("/api") && !isPublicApiRoute(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  const limit = rateLimitFor(pathname);
  if (limit) {
    const result = checkRateLimit(limit, clientIp(request.headers));
    if (!result.allowed) return tooManyRequests(result.retryAfterSeconds);
  }

  // Per-IP limits do not bound spend on their own, so answer generation also
  // draws against a site-wide daily budget. Search keeps working when it runs out.
  if (limit === "ask") {
    const budget = consumeDailyAskBudget();
    if (!budget.allowed) {
      return NextResponse.json(
        { error: "Ask AI has hit its daily limit. Text and semantic search still work." },
        { status: 429 },
      );
    }
  }

  // The public surface is a single page; there is no /unlock or demo route here.
  if (!pathname.startsWith("/api") && pathname !== "/") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

function instructorsMiddleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api") && !isInstructorsApiRoute(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  // Only a started comparison is metered. The GET on the same path is the
  // browser polling a run it already paid for, at roughly one request a
  // second, and metering that would throttle the progress display itself.
  if (pathname === "/api/instructors/compare" && request.method === "POST") {
    const result = checkRateLimit("compare", clientIp(request.headers));
    if (!result.allowed) return tooManyRequests(result.retryAfterSeconds);

    // Per-IP limits do not bound spend, because a botnet is many addresses.
    // This is the number that caps the bill.
    if (!consumeDailyCompareBudget().allowed) {
      return NextResponse.json(
        { error: "Comparisons have hit their daily limit. Try again tomorrow." },
        { status: 429 },
      );
    }
  }

  if (pathname === "/api/instructors/runs") {
    const result = checkRateLimit("search", clientIp(request.headers));
    if (!result.allowed) return tooManyRequests(result.retryAfterSeconds);
  }

  if (!pathname.startsWith("/api") && !isInstructorsPagePath(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

async function fullMiddleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The PIN gate guards the tunnelled demo host, not local development. Without
  // this the dev server on port 3417 would lock itself out, since .env.local
  // carries no DEMO_PIN.
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const credentials = demoCredentials();

  // Fail closed: an unconfigured PIN locks the demo rather than opening it.
  if (!credentials) {
    return new NextResponse(
      "Demo is not configured. Set DEMO_PIN and DEMO_SECRET.",
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }

  if (UNLOCK_PATHS.has(pathname)) return NextResponse.next();

  const unlocked = await verifyDemoCookie(
    request.cookies.get(DEMO_COOKIE)?.value,
    credentials.secret,
  );

  if (!unlocked) {
    // APIs get a status a fetch can act on; pages get the PIN screen.
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Locked. Enter the demo PIN." }, { status: 401 });
    }
    const unlockUrl = new URL("/unlock", request.url);
    if (pathname !== "/") unlockUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(unlockUrl);
  }

  const limit = rateLimitFor(pathname);
  if (limit) {
    const result = checkRateLimit(limit, clientIp(request.headers));
    if (!result.allowed) return tooManyRequests(result.retryAfterSeconds);
  }

  if (WORKFLOW_PATHS.has(pathname) && request.method === "POST") {
    const result = checkRateLimit("compare", clientIp(request.headers));
    if (!result.allowed) return tooManyRequests(result.retryAfterSeconds);
  }

  return NextResponse.next();
}

export function middleware(request: NextRequest) {
  if (MODE === "public") return publicMiddleware(request);
  if (MODE === "instructors") return instructorsMiddleware(request);
  return fullMiddleware(request);
}

export const config = {
  // Skip Next internals and static assets; the PIN screen still needs its CSS.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)"],
};
