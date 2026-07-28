import { NextRequest, NextResponse } from "next/server";
import {
  DEMO_COOKIE,
  DEMO_COOKIE_MAX_AGE,
  demoCredentials,
  issueDemoCookie,
  timingSafeEqual,
} from "@/lib/demoAuth";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export async function POST(request: NextRequest) {
  const credentials = demoCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Demo is not configured." }, { status: 503 });
  }

  // Rate limit before comparing, so a brute-force run is throttled on attempts
  // rather than on successes.
  const limit = checkRateLimit("unlock", clientIp(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";

  if (!timingSafeEqual(pin, credentials.pin)) {
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: DEMO_COOKIE,
    value: await issueDemoCookie(credentials.secret),
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: DEMO_COOKIE_MAX_AGE,
  });
  return response;
}
