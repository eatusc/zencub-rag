import { describe, expect, it } from "vitest";
import { isZeroPaidRun, semanticRetrievalFor } from "@/lib/compareRetrievalPolicy";

describe("semanticRetrievalFor", () => {
  it("runs vector retrieval for Local Qwen by default", () => {
    const decision = semanticRetrievalFor("qwen", { localSemantic: true, hasOpenAiKey: true });
    expect(decision.enabled).toBe(true);
    expect(isZeroPaidRun("qwen", decision)).toBe(false);
  });

  it("keeps strict zero-paid mode available for Local Qwen", () => {
    const decision = semanticRetrievalFor("qwen", { localSemantic: false, hasOpenAiKey: true });
    expect(decision).toEqual({ enabled: false, reason: expect.stringContaining("RAG_COMPARE_LOCAL_SEMANTIC=off") });
    expect(isZeroPaidRun("qwen", decision)).toBe(true);
  });

  it("does not let the Local Qwen switch turn off vector retrieval for paid providers", () => {
    expect(semanticRetrievalFor("openai", { localSemantic: false, hasOpenAiKey: true }).enabled).toBe(true);
    expect(semanticRetrievalFor("openrouter", { localSemantic: false, hasOpenAiKey: true }).enabled).toBe(true);
  });

  it("says why when there is no OpenAI key, instead of returning nothing silently", () => {
    const decision = semanticRetrievalFor("openai", { localSemantic: true, hasOpenAiKey: false });
    expect(decision).toEqual({ enabled: false, reason: expect.stringContaining("no OpenAI key") });
    expect(isZeroPaidRun("openai", decision)).toBe(false);
  });
});
