import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_KEYWORD_TERMS,
  joinedConversationQuery,
  keywordTerms,
  parseRewrite,
  parseRewriteResult,
  planRetrievalQueries,
} from "@/lib/followUpQuery";
import { KEYWORD_RELAX_THRESHOLD, RETAINED_CONTEXT_SLOTS, mergeRetainedContext, textResultsRelaxed } from "@/lib/ragPipeline";
import type { RagSearchResult } from "@/lib/types";

const conversation = [{ question: "How do I escape side control?", answer: "Frame, shrimp, recover guard." }];
const followUp = "what if they're blocking my hip?";

function fakeOpenAI(create: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function reply(content: string, totalTokens?: number) {
  return Promise.resolve({
    choices: [{ message: { content } }],
    ...(totalTokens !== undefined ? { usage: { total_tokens: totalTokens } } : {}),
  });
}

function row(id: string, videoId = "v"): RagSearchResult {
  return { id, video_id: videoId, chunk_index: 0, start_seconds: 0, end_seconds: 30, text: "a real transcript chunk about grips and frames. ".repeat(6), metadata: null, rank: 0 };
}

describe("keywordTerms", () => {
  it("drops contraction fragments and operator words", () => {
    expect(keywordTerms("What if they're blocking my hip OR knee, and not frames?"))
      .toEqual(["what", "if", "they", "blocking", "my", "hip", "knee", "frames"]);
  });

  it("strips all syntax to plain words", () => {
    expect(keywordTerms('"side control" -knee | hip')).toEqual(["side", "control", "knee", "hip"]);
    expect(keywordTerms("?!")).toEqual([]);
  });
});

describe("parseRewrite", () => {
  it("accepts a sentence and a short keyword phrase", () => {
    expect(parseRewrite(JSON.stringify({
      standalone_question: "How do I escape side control when they block my hip?",
      keywords: "side control escape hip block",
    }))).toEqual({
      vector: "How do I escape side control when they block my hip?",
      keyword: "side control escape hip block",
    });
  });

  it("truncates a long keyword phrase instead of sending the sentence", () => {
    const long = Array.from({ length: MAX_KEYWORD_TERMS + 3 }, (_, i) => `word${i}`).join(" ");
    const keyword = parseRewrite(JSON.stringify({ standalone_question: "Escape side control?", keywords: long }))?.keyword;
    expect(keyword?.split(" ")).toHaveLength(MAX_KEYWORD_TERMS);
    expect(keyword).toBe("word0 word1 word2 word3 word4 word5");
  });

  it("derives keywords from the sentence without filler when the model gives none", () => {
    // The real eval case: the model echoed the sentence as keywords.
    expect(parseRewrite(JSON.stringify({
      standalone_question: "how does the berimbolo work from de la riva?",
      keywords: "how does the berimbolo work from de la riva?",
    }))?.keyword).toBe("berimbolo de la riva");
    expect(parseRewrite(JSON.stringify({ standalone_question: "how does the berimbolo work?", keywords: "" }))?.keyword)
      .toBe("berimbolo");
  });

  it("rejects a rewrite with no topic word from the user's own text", () => {
    const steered = JSON.stringify({ standalone_question: "best crypto exchange", keywords: "crypto exchange bonus" });
    expect(parseRewrite(steered, "How do I escape side control? what if they're blocking my hip?")).toBeNull();
    const onTopic = JSON.stringify({ standalone_question: "escape side control when they block my hip", keywords: "side control hip block" });
    expect(parseRewrite(onTopic, "How do I escape side control? what if they're blocking my hip?")).not.toBeNull();
  });

  it("rejects an off-topic sentence even when the keyword phrase is on topic", () => {
    // The vector sentence drives vector search and the reranker on its own.
    const userText = "How do I escape side control? what if they're blocking my hip?";
    const mixed = JSON.stringify({ standalone_question: "best crypto exchange bonus", keywords: "side control hip block" });
    expect(parseRewriteResult(mixed, userText)).toEqual({ ok: false, reason: "off_topic" });
    expect(parseRewrite(mixed, userText)).toBeNull();
  });

  it("reports why a rewrite was rejected", () => {
    expect(parseRewriteResult("not json")).toEqual({ ok: false, reason: "invalid" });
    const steered = JSON.stringify({ standalone_question: "best crypto exchange", keywords: "crypto exchange" });
    expect(parseRewriteResult(steered, "escape side control")).toEqual({ ok: false, reason: "off_topic" });
  });

  it("returns null when nothing meaningful is left", () => {
    expect(parseRewrite(JSON.stringify({ standalone_question: "what is it?", keywords: "the a" }))).toBeNull();
  });

  it("rejects malformed or empty output", () => {
    expect(parseRewrite("not json")).toBeNull();
    expect(parseRewrite(JSON.stringify({ standalone_question: "" }))).toBeNull();
    expect(parseRewrite(JSON.stringify({ keywords: "hip" }))).toBeNull();
  });
});

describe("planRetrievalQueries", () => {
  it("leaves a first question untouched and makes no model call", async () => {
    const create = vi.fn();
    await expect(planRetrievalQueries("kimura from closed guard", [], fakeOpenAI(create), "m"))
      .resolves.toEqual({ vector: "kimura from closed guard", keyword: "kimura from closed guard", rewrite: "none" });
    expect(create).not.toHaveBeenCalled();
  });

  it("uses separate queries from the rewrite model", async () => {
    const create = vi.fn((..._args: unknown[]) => reply(JSON.stringify({
      standalone_question: "How do I escape side control when they block my hip?",
      keywords: "side control hip block",
    }), 87));
    const plan = await planRetrievalQueries(followUp, conversation, fakeOpenAI(create), "m");
    expect(plan).toMatchObject({
      vector: "How do I escape side control when they block my hip?",
      keyword: "side control hip block",
      rewrite: "model",
      telemetry: { tokens: 87 },
    });
    expect(plan.telemetry?.failure).toBeUndefined();
    expect(plan.telemetry?.ms).toBeGreaterThanOrEqual(0);
    // Bounded: no SDK retries, explicit timeout.
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0, timeout: 4_000 });
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 150 });
  });

  it("falls back to the joined query when the model fails", async () => {
    const joined = joinedConversationQuery(followUp, conversation);
    const timedOut = fakeOpenAI(() => Promise.reject(new Error("Request timed out.")));
    await expect(planRetrievalQueries(followUp, conversation, timedOut, "m"))
      .resolves.toMatchObject({ vector: joined, keyword: joined, rewrite: "fallback", telemetry: { failure: "timeout" } });
    const failing = fakeOpenAI(() => Promise.reject(new Error("500 server error")));
    await expect(planRetrievalQueries(followUp, conversation, failing, "m"))
      .resolves.toMatchObject({ rewrite: "fallback", telemetry: { failure: "error" } });
    const garbage = fakeOpenAI(() => reply("{}", 40));
    await expect(planRetrievalQueries(followUp, conversation, garbage, "m"))
      .resolves.toMatchObject({ rewrite: "fallback", telemetry: { failure: "invalid", tokens: 40 } });
    const steered = fakeOpenAI(() => reply(JSON.stringify({ standalone_question: "best crypto exchange", keywords: "crypto bonus" })));
    await expect(planRetrievalQueries(followUp, conversation, steered, "m"))
      .resolves.toMatchObject({ rewrite: "fallback", telemetry: { failure: "off_topic" } });
  });

  it("falls back without a client or when switched off", async () => {
    const create = vi.fn();
    await expect(planRetrievalQueries(followUp, conversation, null, "m"))
      .resolves.toMatchObject({ rewrite: "fallback", telemetry: { ms: 0, failure: "no_client" } });
    await expect(planRetrievalQueries(followUp, conversation, fakeOpenAI(create), "m", { enabled: false }))
      .resolves.toMatchObject({ rewrite: "fallback", telemetry: { ms: 0, failure: "disabled" } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("textResultsRelaxed", () => {
  it("keeps strict results when there are enough", async () => {
    const search = vi.fn(async () => Array.from({ length: KEYWORD_RELAX_THRESHOLD }, (_, i) => row(`s${i}`)));
    const result = await textResultsRelaxed("side control escape", 20, search);
    expect(result.relaxed).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("relaxes to any-term below the threshold, strict rows first, no duplicates", async () => {
    const search = vi.fn(async () => [row("strict-1")]);
    const anyTerm = vi.fn(async () => [
      { ...row("strict-1"), matched_terms: 4 },
      { ...row("loose-1"), matched_terms: 3 },
      { ...row("loose-2"), matched_terms: 2 },
    ]);
    const result = await textResultsRelaxed("side control hip block", 20, search, anyTerm);
    expect(anyTerm).toHaveBeenCalledWith(["side", "control", "hip", "block"], 20);
    expect(result).toEqual({ relaxed: true, rows: [row("strict-1"), row("loose-1"), row("loose-2")] });
  });

  it("drops relaxed rows that match only one term", async () => {
    const anyTerm = vi.fn(async () => [{ ...row("two"), matched_terms: 2 }, { ...row("one"), matched_terms: 1 }]);
    const result = await textResultsRelaxed("hip block escape", 20, async () => [], anyTerm);
    expect(result.rows.map((r) => r.id)).toEqual(["two"]);
  });

  it("does not relax a single-word query", async () => {
    const search = vi.fn(async () => [] as RagSearchResult[]);
    const anyTerm = vi.fn();
    await expect(textResultsRelaxed("kimura", 20, search, anyTerm)).resolves.toEqual({ rows: [], relaxed: false });
    expect(anyTerm).not.toHaveBeenCalled();
  });

  it("keeps strict results when the database lacks the any-term function", async () => {
    const result = await textResultsRelaxed("hip block", 20, async () => [row("s0")], async () => null);
    expect(result).toEqual({ rows: [row("s0")], relaxed: false });
  });

  it("respects the limit after merging", async () => {
    const anyTerm = vi.fn(async () => Array.from({ length: 10 }, (_, i) => ({ ...row(`l${i}`), matched_terms: 2 })));
    const result = await textResultsRelaxed("hip block", 4, async () => [row("s0")], anyTerm);
    expect(result.rows.map((r) => r.id)).toEqual(["s0", "l0", "l1", "l2"]);
  });
});

describe("mergeRetainedContext", () => {
  const prior = Array.from({ length: 8 }, (_, i) => row(`p${i}`, `pv${i}`));
  const fresh = Array.from({ length: 20 }, (_, i) => row(`f${i}`, `fv${i}`));

  it("keeps at most RETAINED_CONTEXT_SLOTS retained rows, so fresh rows fill the rerank pool", () => {
    const pool = mergeRetainedContext(prior, fresh).slice(0, 12);
    expect(pool.filter((r) => r.id.startsWith("p"))).toHaveLength(RETAINED_CONTEXT_SLOTS);
    expect(pool.filter((r) => r.id.startsWith("f"))).toHaveLength(12 - RETAINED_CONTEXT_SLOTS);
    // Best retained rows (client sends them in answer order) are the ones kept.
    expect(pool.filter((r) => r.id.startsWith("p")).map((r) => r.id)).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("interleaves fresh first and drops duplicates", () => {
    const merged = mergeRetainedContext([row("p0", "a"), row("f0", "b")], [row("f0", "b"), row("f1", "c")]);
    expect(merged.map((r) => r.id)).toEqual(["f0", "p0", "f1"]);
  });

  it("lets fresh rows win the per-video cap", () => {
    // Codex case: p0 and p1 from video V must not push out fresh f2 from V.
    const merged = mergeRetainedContext(
      [row("p0", "V"), row("p1", "V"), row("p2", "W")],
      [row("f0", "A"), row("f1", "B"), row("f2", "V"), row("f3", "V")],
    );
    expect(merged.map((r) => r.id)).toEqual(["f0", "p2", "f1", "f2", "f3"]);
  });

  it("admits a retained row when its video has room", () => {
    const merged = mergeRetainedContext([row("p0", "V")], [row("f0", "V"), row("f1", "A")]);
    expect(merged.map((r) => r.id)).toEqual(["f0", "p0", "f1"]);
  });

  it("is just the fresh rows on a first question", () => {
    expect(mergeRetainedContext([], fresh.slice(0, 3)).map((r) => r.id)).toEqual(["f0", "f1", "f2"]);
  });
});
