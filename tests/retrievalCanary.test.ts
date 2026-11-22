import { describe, expect, it } from "vitest";
import {
  isInstructorsApiRoute,
  isMcpApiRoute,
  isPublicApiRoute,
} from "@/lib/appMode";
import {
  CANARY_MIN_RESULTS,
  CanaryMissingKeyError,
  classifyCanaryError,
  runRetrievalCanary,
} from "@/lib/retrievalCanary";

const rows = (count: number) => Array.from({ length: count }, (_, id) => ({ id }));

describe("runRetrievalCanary", () => {
  it("passes when vector search returns enough rows", async () => {
    const result = await runRetrievalCanary(async () => rows(12));
    expect(result).toMatchObject({ ok: true, results: 12 });
    expect(result.failure).toBeUndefined();
  });

  it("fails on zero rows, the silent shape of the original outage", async () => {
    const result = await runRetrievalCanary(async () => []);
    expect(result).toMatchObject({ ok: false, results: 0, failure: "too_few_results" });
  });

  it("fails just below the minimum and passes at it", async () => {
    expect((await runRetrievalCanary(async () => rows(CANARY_MIN_RESULTS - 1))).ok).toBe(false);
    expect((await runRetrievalCanary(async () => rows(CANARY_MIN_RESULTS))).ok).toBe(true);
  });

  it("reports a revoked key as auth", async () => {
    const result = await runRetrievalCanary(async () => {
      throw Object.assign(new Error("Incorrect API key provided: sk-abc"), { status: 401 });
    });
    expect(result).toMatchObject({ ok: false, failure: "auth", upstream_status: 401 });
  });

  it("never carries the upstream message, which can quote the key", async () => {
    const result = await runRetrievalCanary(async () => {
      throw Object.assign(new Error("Incorrect API key provided: sk-secret"), { status: 401 });
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("fails on a hung search rather than hanging itself", async () => {
    const result = await runRetrievalCanary(() => new Promise(() => {}), 10);
    expect(result).toMatchObject({ ok: false, failure: "timeout" });
  });
});

describe("classifyCanaryError", () => {
  it("separates the causes on-call would act on differently", () => {
    expect(classifyCanaryError(new CanaryMissingKeyError()).failure).toBe("missing_key");
    expect(classifyCanaryError({ status: 403 }).failure).toBe("auth");
    expect(classifyCanaryError({ status: 429 }).failure).toBe("rate_limited");
    expect(classifyCanaryError({ status: 503 }).failure).toBe("provider");
    expect(classifyCanaryError(new Error("database")).failure).toBe("error");
  });
});

describe("canary route exposure", () => {
  it("is reachable only on the loopback MCP surface", () => {
    expect(isMcpApiRoute("/api/health/retrieval")).toBe(true);
    expect(isPublicApiRoute("/api/health/retrieval")).toBe(false);
    expect(isInstructorsApiRoute("/api/health/retrieval")).toBe(false);
  });
});
