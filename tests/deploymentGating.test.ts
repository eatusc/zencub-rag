import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isInstructorsApiRoute,
  isInstructorsPagePath,
  isPublicApiRoute,
  publicInstructorsProvider,
} from "@/lib/appMode";
import { issueDemoCookie, timingSafeEqual, verifyDemoCookie } from "@/lib/demoAuth";
import {
  LIMITS,
  checkRateLimit,
  clientIp,
  consumeDailyAskBudget,
  consumeDailyCompareBudget,
  resetRateLimits,
} from "@/lib/rateLimit";

const SECRET = "test-secret-value";

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RAG_PUBLIC_DAILY_ASK_BUDGET;
});

describe("isPublicApiRoute", () => {
  it("allows only the three search endpoints and health", () => {
    expect(isPublicApiRoute("/api/rag/search")).toBe(true);
    expect(isPublicApiRoute("/api/rag/vector-search")).toBe(true);
    expect(isPublicApiRoute("/api/rag/ask")).toBe(true);
    expect(isPublicApiRoute("/api/health")).toBe(true);
  });

  it("rejects the LangGraph, Instructor Compare, and Langfuse routes", () => {
    expect(isPublicApiRoute("/api/rag/instructor-compare")).toBe(false);
    expect(isPublicApiRoute("/api/rag/graph-follow-up")).toBe(false);
    expect(isPublicApiRoute("/api/rag/graph-follow-up/recover")).toBe(false);
    expect(isPublicApiRoute("/api/rag/providers")).toBe(false);
    expect(isPublicApiRoute("/api/langfuse/traces")).toBe(false);
  });

  it("does not match on prefix, so a suffixed path cannot slip through", () => {
    expect(isPublicApiRoute("/api/rag/search/../instructor-compare")).toBe(false);
    expect(isPublicApiRoute("/api/rag/asking")).toBe(false);
  });
});

describe("demo cookie", () => {
  it("round-trips a freshly issued cookie", async () => {
    const cookie = await issueDemoCookie(SECRET);
    expect(await verifyDemoCookie(cookie, SECRET)).toBe(true);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await issueDemoCookie(SECRET);
    expect(await verifyDemoCookie(cookie, "other-secret")).toBe(false);
  });

  it("rejects a forged signature and a missing cookie", async () => {
    expect(await verifyDemoCookie(`${Date.now() + 60_000}.deadbeef`, SECRET)).toBe(false);
    expect(await verifyDemoCookie(undefined, SECRET)).toBe(false);
    expect(await verifyDemoCookie("no-separator", SECRET)).toBe(false);
  });

  it("rejects a validly signed cookie once it expires", async () => {
    const cookie = await issueDemoCookie(SECRET);
    // Sessions last 12 hours; jump past that.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
    expect(await verifyDemoCookie(cookie, SECRET)).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("compares equal and unequal strings", () => {
    expect(timingSafeEqual("123456", "123456")).toBe(true);
    expect(timingSafeEqual("123456", "123457")).toBe(false);
    expect(timingSafeEqual("123456", "12345")).toBe(false);
  });
});

describe("checkRateLimit", () => {
  it("allows up to the limit then rejects with a retry hint", () => {
    for (let i = 0; i < LIMITS.ask.max; i += 1) {
      expect(checkRateLimit("ask", "1.1.1.1").allowed).toBe(true);
    }
    const blocked = checkRateLimit("ask", "1.1.1.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks each address separately", () => {
    for (let i = 0; i < LIMITS.ask.max; i += 1) checkRateLimit("ask", "1.1.1.1");
    expect(checkRateLimit("ask", "2.2.2.2").allowed).toBe(true);
  });

  it("keeps ask and search budgets independent", () => {
    for (let i = 0; i < LIMITS.ask.max; i += 1) checkRateLimit("ask", "3.3.3.3");
    expect(checkRateLimit("ask", "3.3.3.3").allowed).toBe(false);
    expect(checkRateLimit("search", "3.3.3.3").allowed).toBe(true);
  });

  it("lets a blocked address through again once the window slides past", () => {
    vi.useFakeTimers();
    for (let i = 0; i < LIMITS.ask.max; i += 1) checkRateLimit("ask", "4.4.4.4");
    expect(checkRateLimit("ask", "4.4.4.4").allowed).toBe(false);

    vi.setSystemTime(Date.now() + LIMITS.ask.windowMs + 1_000);
    expect(checkRateLimit("ask", "4.4.4.4").allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers cf-connecting-ip, since only cloudflared reaches the origin", () => {
    const headers = new Headers({
      "cf-connecting-ip": "9.9.9.9",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    });
    expect(clientIp(headers)).toBe("9.9.9.9");
  });

  it("falls back to the first x-forwarded-for entry, then to unknown", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("consumeDailyAskBudget", () => {
  it("stops once the configured budget is spent", () => {
    process.env.RAG_PUBLIC_DAILY_ASK_BUDGET = "3";
    expect(consumeDailyAskBudget().allowed).toBe(true);
    expect(consumeDailyAskBudget().allowed).toBe(true);
    expect(consumeDailyAskBudget().allowed).toBe(true);

    const blocked = consumeDailyAskBudget();
    expect(blocked.allowed).toBe(false);
    expect(blocked.used).toBe(3);
    expect(blocked.budget).toBe(3);
  });

  it("resets when the calendar day rolls over", () => {
    process.env.RAG_PUBLIC_DAILY_ASK_BUDGET = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));

    expect(consumeDailyAskBudget().allowed).toBe(true);
    expect(consumeDailyAskBudget().allowed).toBe(false);

    vi.setSystemTime(new Date("2026-07-28T00:05:00Z"));
    expect(consumeDailyAskBudget().allowed).toBe(true);
  });
});

describe("instructors surface gating", () => {
  it("exposes only the comparison workflow and health", () => {
    expect(isInstructorsApiRoute("/api/instructors/compare")).toBe(true);
    expect(isInstructorsApiRoute("/api/instructors/runs")).toBe(true);
    expect(isInstructorsApiRoute("/api/health")).toBe(true);
  });

  it("does not expose the demo's compare route, which takes a caller-chosen provider", () => {
    expect(isInstructorsApiRoute("/api/rag/instructor-compare")).toBe(false);
    expect(isInstructorsApiRoute("/api/rag/graph-follow-up")).toBe(false);
    expect(isInstructorsApiRoute("/api/rag/ask")).toBe(false);
    expect(isInstructorsApiRoute("/api/langfuse/traces")).toBe(false);
    expect(isInstructorsApiRoute("/api/instructors/compare/../rag/ask")).toBe(false);
  });

  it("serves the landing page and comparison permalinks only", () => {
    expect(isInstructorsPagePath("/")).toBe(true);
    expect(isInstructorsPagePath("/c/9a401113-f954-4ef4-9213-f8b29914b32f")).toBe(true);
    expect(isInstructorsPagePath("/c/not-a-uuid")).toBe(false);
    expect(isInstructorsPagePath("/unlock")).toBe(false);
    expect(isInstructorsPagePath("/c/9a401113-f954-4ef4-9213-f8b29914b32f/edit")).toBe(false);
  });

  it("pins the provider server-side, ignoring anything a caller could send", () => {
    delete process.env.RAG_INSTRUCTORS_PROVIDER;
    expect(publicInstructorsProvider()).toBe("openai");
    process.env.RAG_INSTRUCTORS_PROVIDER = "openrouter";
    expect(publicInstructorsProvider()).toBe("openrouter");
    // Claude spawns a CLI process per call, so it is not selectable here.
    process.env.RAG_INSTRUCTORS_PROVIDER = "claude";
    expect(publicInstructorsProvider()).toBe("openai");
    delete process.env.RAG_INSTRUCTORS_PROVIDER;
  });
});

describe("consumeDailyCompareBudget", () => {
  it("meters comparisons separately from asks", () => {
    process.env.RAG_INSTRUCTORS_DAILY_BUDGET = "2";
    process.env.RAG_PUBLIC_DAILY_ASK_BUDGET = "1";

    expect(consumeDailyCompareBudget().allowed).toBe(true);
    expect(consumeDailyAskBudget().allowed).toBe(true);
    // The ask budget is spent; the comparison budget still has one left.
    expect(consumeDailyAskBudget().allowed).toBe(false);
    expect(consumeDailyCompareBudget().allowed).toBe(true);
    expect(consumeDailyCompareBudget().allowed).toBe(false);

    delete process.env.RAG_INSTRUCTORS_DAILY_BUDGET;
  });
});
