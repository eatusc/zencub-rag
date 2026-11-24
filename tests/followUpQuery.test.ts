import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_KEYWORD_TERMS,
  joinedConversationQuery,
  keywordTerms,
  parseRewrite,
  planRetrievalQueries,
} from "@/lib/followUpQuery";
import { KEYWORD_RELAX_THRESHOLD, textResultsRelaxed } from "@/lib/ragPipeline";
import type { RagSearchResult } from "@/lib/types";

const conversation = [{ question: "How do I escape side control?", answer: "Frame, shrimp, recover guard." }];
const followUp = "what if they're blocking my hip?";

function fakeOpenAI(create: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function reply(content: string) {
  return Promise.resolve({ choices: [{ message: { content } }] });
}

function row(id: string): RagSearchResult {
  return { id, video_id: "v", chunk_index: 0, start_seconds: 0, end_seconds: 30, text: "t", metadata: null, rank: 0 };
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
    })));
    const plan = await planRetrievalQueries(followUp, conversation, fakeOpenAI(create), "m");
    expect(plan).toEqual({
      vector: "How do I escape side control when they block my hip?",
      keyword: "side control hip block",
      rewrite: "model",
    });
    // Bounded: no SDK retries, explicit timeout.
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0, timeout: 4_000 });
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 150 });
  });

  it("falls back to the joined query when the model fails", async () => {
    const joined = joinedConversationQuery(followUp, conversation);
    const failing = fakeOpenAI(() => Promise.reject(new Error("timeout")));
    await expect(planRetrievalQueries(followUp, conversation, failing, "m"))
      .resolves.toEqual({ vector: joined, keyword: joined, rewrite: "fallback" });
    const garbage = fakeOpenAI(() => reply("{}"));
    await expect(planRetrievalQueries(followUp, conversation, garbage, "m"))
      .resolves.toMatchObject({ rewrite: "fallback" });
  });

  it("falls back without a client or when switched off", async () => {
    const create = vi.fn();
    await expect(planRetrievalQueries(followUp, conversation, null, "m")).resolves.toMatchObject({ rewrite: "fallback" });
    await expect(planRetrievalQueries(followUp, conversation, fakeOpenAI(create), "m", { enabled: false }))
      .resolves.toMatchObject({ rewrite: "fallback" });
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
