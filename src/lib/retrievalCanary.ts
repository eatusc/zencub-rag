// An active check that vector retrieval works, independent of user traffic.
//
// Hybrid search deliberately survives a vector failure by falling back to
// keyword results, and /api/health only counts rows. So when the OpenAI key was
// revoked, search kept answering, health stayed green, and nothing reported it
// for up to 76 days. Traffic-based alerting would not have helped either: the
// search log had zero rows in October, and a rate over zero requests never
// crosses a threshold. This probe creates its own request instead.

export const CANARY_QUERY = "how to escape side control";
export const CANARY_MATCH_COUNT = 12;
// A healthy index returns the full match count for this query. Requiring
// several rows means a nearly empty or half-restored index also fails.
export const CANARY_MIN_RESULTS = 5;
export const CANARY_TIMEOUT_MS = 20_000;

export type CanaryFailure =
  | "missing_key"
  | "auth"
  | "rate_limited"
  | "provider"
  | "timeout"
  | "too_few_results"
  | "error";

export type CanaryResult = {
  ok: boolean;
  results: number;
  duration_ms: number;
  failure?: CanaryFailure;
  upstream_status?: number;
};

export class CanaryTimeoutError extends Error {}
export class CanaryMissingKeyError extends Error {}

// Returns a class and a status, never the upstream message: OpenAI's 401 body
// quotes part of the rejected key, and this result is written to logs and pages.
export function classifyCanaryError(error: unknown): Pick<CanaryResult, "failure" | "upstream_status"> {
  if (error instanceof CanaryMissingKeyError) return { failure: "missing_key" };
  if (error instanceof CanaryTimeoutError) return { failure: "timeout" };

  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return { failure: "error" };
  if (status === 401 || status === 403) return { failure: "auth", upstream_status: status };
  if (status === 429) return { failure: "rate_limited", upstream_status: status };
  if (status >= 500) return { failure: "provider", upstream_status: status };
  return { failure: "error", upstream_status: status };
}

export async function runRetrievalCanary(
  search: (query: string, limit: number) => Promise<unknown[]>,
  timeoutMs: number = CANARY_TIMEOUT_MS,
): Promise<CanaryResult> {
  const startedAt = performance.now();
  const duration = () => Math.round(performance.now() - startedAt);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CanaryTimeoutError()), timeoutMs);
    });
    const rows = await Promise.race([search(CANARY_QUERY, CANARY_MATCH_COUNT), timeout]);
    if (rows.length < CANARY_MIN_RESULTS) {
      return { ok: false, results: rows.length, duration_ms: duration(), failure: "too_few_results" };
    }
    return { ok: true, results: rows.length, duration_ms: duration() };
  } catch (error) {
    return { ok: false, results: 0, duration_ms: duration(), ...classifyCanaryError(error) };
  } finally {
    clearTimeout(timer);
  }
}
