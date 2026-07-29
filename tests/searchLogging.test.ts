import { describe, expect, it } from "vitest";
import { buildSearchLogPayload } from "@/lib/searchLogging";

describe("buildSearchLogPayload", () => {
  it("stores actual provider/retrieval in columns and requested values in metadata", () => {
    const payload = buildSearchLogPayload({
      query: "knee cut defense",
      action: "ask",
      provider: "openrouter",
      retrieval: "vector",
      requestedProvider: "qwen",
      requestedRetrieval: "auto",
      metadata: { conversation_turns: 2 },
      outcome: {
        success: true,
        statusCode: 200,
        durationMs: 812.7,
        resultCount: 8,
        model: "qwen/test",
      },
    });

    expect(payload.provider).toBe("openrouter");
    expect(payload.retrieval).toBe("vector");
    expect(payload.metadata).toMatchObject({
      requested_provider: "qwen",
      requested_retrieval: "auto",
      conversation_turns: 2,
      success: true,
      status_code: 200,
      duration_ms: 813,
      result_count: 8,
      model: "qwen/test",
    });
  });

  it("records exact citation validation counts and flags rejected citations", () => {
    const payload = buildSearchLogPayload({
      query: "armbar escape",
      action: "ask",
      provider: "openrouter",
      retrieval: "hybrid",
      outcome: {
        success: true,
        statusCode: 200,
        durationMs: 100,
        resultCount: 8,
        citationRequestedCount: 3,
        citationVerifiedCount: 2,
        citationRejectedCount: 1,
        citationDuplicateCount: 0,
        citationMissing: false,
      },
    });

    expect(payload.metadata).toMatchObject({
      citation_requested_count: 3,
      citation_verified_count: 2,
      citation_rejected_count: 1,
      citation_duplicate_count: 0,
      citation_missing: false,
      citation_validation_failed: true,
    });
  });

  it("treats a citation-free answer as a validation failure even with zero rejected IDs", () => {
    const payload = buildSearchLogPayload({
      query: "guard retention",
      action: "ask",
      provider: "openrouter",
      retrieval: "hybrid",
      outcome: {
        success: true,
        statusCode: 200,
        durationMs: 100,
        resultCount: 8,
        citationRequestedCount: 0,
        citationVerifiedCount: 0,
        citationRejectedCount: 0,
        citationMissing: true,
      },
    });

    expect(payload.metadata).toMatchObject({
      citation_rejected_count: 0,
      citation_missing: true,
      citation_validation_failed: true,
    });
  });

  it("records failure outcomes without leaking raw error messages", () => {
    const payload = buildSearchLogPayload({
      query: "heel hook defense",
      action: "semantic",
      retrieval: "vector",
      outcome: {
        success: false,
        statusCode: 500,
        durationMs: -10,
        resultCount: -1,
        errorCode: "embedding_missing",
      },
    });

    expect(payload.metadata).toMatchObject({
      success: false,
      status_code: 500,
      duration_ms: 0,
      result_count: 0,
      error_code: "embedding_missing",
    });
  });

  it("keeps legacy action-only logs valid for non-public workflows", () => {
    const payload = buildSearchLogPayload({
      query: "compare knee cut defense",
      action: "ask",
      provider: "openai",
      retrieval: "hybrid",
      metadata: { workflow: "instructor_compare" },
    });

    expect(payload).toEqual({
      query: "compare knee cut defense",
      action: "ask",
      provider: "openai",
      retrieval: "hybrid",
      metadata: { workflow: "instructor_compare" },
    });
  });
});
