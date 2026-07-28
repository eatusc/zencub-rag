import { NextResponse, type NextRequest } from "next/server";
import { getAppMode, isPublicApiRoute } from "@/lib/appMode";
import { DEMO_COOKIE, demoCredentials, verifyDemoCookie } from "@/lib/demoAuth";
import {
  checkRateLimit,
  clientIp,
  consumeDailyAskBudget,
  type LimitName,
} from "@/lib/rateLimit";

// APP_MODE is inlined at build time, so each deployment builds its own bundle
// and this branch is decided once rather than per request.
const MODE = getAppMode();

const UNLOCK_PATHS = new Set(["/unlock", "/api/unlock"]);

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

  return NextResponse.next();
}

export function middleware(request: NextRequest) {
  return MODE === "public" ? publicMiddleware(request) : fullMiddleware(request);
}

export const config = {
  // Skip Next internals and static assets; the PIN screen still needs its CSS.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)"],
};
