// Per-IP sliding-window rate limiting.
//
// This is viable in-process because the app runs as a long-lived `next start`
// server behind a Cloudflare Tunnel, not as serverless functions. Cloudflare's
// own WAF rate limiting sits in front of this; treat this as the backstop that
// still applies if a request reaches the origin another way.

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

// Ask runs retrieval, a rerank, and a generation, so it gets a much smaller
// budget than plain search.
export const LIMITS = {
  ask: { max: 10, windowMs: 60_000 },
  search: { max: 60, windowMs: 60_000 },
  // A short PIN is brute-forceable without this; 5 tries per 10 minutes puts a
  // six-digit space far out of reach.
  unlock: { max: 5, windowMs: 600_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

// Only cloudflared talks to this origin, so cf-connecting-ip is the real client
// address rather than something a caller can spoof end to end.
export function clientIp(headers: Headers): string {
  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";

  return headers.get("x-real-ip") ?? "unknown";
}

// Bound the map so a flood of distinct addresses cannot grow it without limit.
const MAX_TRACKED_KEYS = 10_000;

function pruneIfLarge(now: number, windowMs: number) {
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((hit) => now - hit >= windowMs)) buckets.delete(key);
  }
}

export function checkRateLimit(name: LimitName, ip: string): RateLimitResult {
  const { max, windowMs } = LIMITS[name];
  const now = Date.now();
  const key = `${name}:${ip}`;

  const bucket = buckets.get(key) ?? { hits: [] };
  const hits = bucket.hits.filter((hit) => now - hit < windowMs);

  if (hits.length >= max) {
    const oldest = hits[0] ?? now;
    buckets.set(key, { hits });
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  hits.push(now);
  buckets.set(key, { hits });
  pruneIfLarge(now, windowMs);

  return { allowed: true, remaining: max - hits.length, retryAfterSeconds: 0 };
}

// Site-wide daily ceiling on answer generation, on top of the per-IP limit.
// Per-IP limits alone do not bound spend, because a botnet is many IPs; this is
// the number that caps the bill. Search is unmetered, so a tripped budget
// degrades the public site to search-only rather than taking it down.
//
// A follow-up costs the same as an opening question: full retrieval, rerank,
// and generation. One reader working a thread to the 6-turn cap spends 6 of
// these, so the budget is sized for threads rather than one-shot questions.
// At roughly $0.001 a call on OpenRouter this ceiling is about $2/day.
const DEFAULT_DAILY_ASK_BUDGET = 2_000;

let askDay = "";
let askCount = 0;

function dailyAskBudget(): number {
  const configured = Number(process.env.RAG_PUBLIC_DAILY_ASK_BUDGET);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_ASK_BUDGET;
}

export function consumeDailyAskBudget(): { allowed: boolean; used: number; budget: number } {
  const budget = dailyAskBudget();
  const today = new Date().toISOString().slice(0, 10);

  if (today !== askDay) {
    askDay = today;
    askCount = 0;
  }

  if (askCount >= budget) return { allowed: false, used: askCount, budget };

  askCount += 1;
  return { allowed: true, used: askCount, budget };
}

// Exposed for tests; the sliding window otherwise leaks state between cases.
export function resetRateLimits() {
  buckets.clear();
  askDay = "";
  askCount = 0;
}
