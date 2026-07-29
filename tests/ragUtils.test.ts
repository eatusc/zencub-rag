import { describe, expect, it } from "vitest";
import {
  coerceAnswer,
  validateAnswerCitations,
  type RagSource,
} from "@/lib/ragUtils";
import type { RagAnswer, RagAnswerCitation } from "@/lib/types";

function source(id: number, overrides: Partial<RagSource> = {}): RagSource {
  return {
    id,
    result_id: `result-${id}`,
    video_id: `video-${id}`,
    title: `Retrieved title ${id}`,
    citation: `Video ${id} @ ${id}:00`,
    channel: `Instructor ${id}`,
    thumbnail_url: `https://images.example/${id}.jpg`,
    start_seconds: id * 60,
    end_seconds: id * 60 + 30,
    source_url: `https://youtube.com/watch?v=video-${id}`,
    watch_url: `https://youtube.com/watch?v=video-${id}&t=${id * 60}s`,
    score: 1 / id,
    text: `Retrieved evidence ${id}`,
    technique: null,
    position: null,
    difficulty: null,
    gi_nogi: null,
    ...overrides,
  };
}

function modelCitation(reference: string): RagAnswerCitation {
  return {
    title: "Model-supplied title",
    citation: reference,
    channel: "Model-supplied channel",
    start_seconds: 999,
    end_seconds: 1_000,
    watch_url: "https://untrusted.example/watch",
    thumbnail_url: "https://untrusted.example/image.jpg",
  };
}

function answer(citations: RagAnswerCitation[], caveats: string[] = []): RagAnswer {
  return {
    answer: "Grounded answer.",
    citations,
    key_takeaways: [],
    follow_up_searches: [],
    suggested_follow_up: null,
    caveats,
  };
}

describe("coerceAnswer citation contract", () => {
  it("keeps at most the three citations allowed by the prompt contract", () => {
    const coerced = coerceAnswer({
      answer: "Test",
      citations: [1, 2, 3, 4, 5],
    });

    expect(coerced.citations.map((citation) => citation.citation)).toEqual(["1", "2", "3"]);
  });
});

describe("validateAnswerCitations", () => {
  it("resolves a numeric source ID and replaces every display field with retrieved metadata", () => {
    const retrieved = source(1);
    const resolved = validateAnswerCitations(answer([modelCitation("1")]), [retrieved]);

    expect(resolved.validation).toEqual({
      requested: 1,
      verified: 1,
      rejected: 0,
      duplicates: 0,
      missing: false,
    });
    expect(resolved.answer.citations).toEqual([{
      title: retrieved.title,
      citation: retrieved.citation,
      channel: retrieved.channel,
      start_seconds: retrieved.start_seconds,
      end_seconds: retrieved.end_seconds,
      watch_url: retrieved.watch_url,
      thumbnail_url: retrieved.thumbnail_url,
    }]);
  });

  it("accepts supported source ID forms without trusting model display metadata", () => {
    const retrieved = source(2);
    for (const reference of ["source 2", "result-2", "video-2", retrieved.citation]) {
      const resolved = validateAnswerCitations(answer([modelCitation(reference)]), [retrieved]);
      expect(resolved.validation.verified, reference).toBe(1);
      expect(resolved.answer.citations[0]?.title, reference).toBe(retrieved.title);
    }
  });

  it("removes an unmatched citation instead of substituting another retrieved source", () => {
    const resolved = validateAnswerCitations(
      answer([modelCitation("source 999")]),
      [source(1), source(2)],
    );

    expect(resolved.answer.citations).toEqual([]);
    expect(resolved.validation).toEqual({
      requested: 1,
      verified: 0,
      rejected: 1,
      duplicates: 0,
      missing: true,
    });
    expect(resolved.answer.caveats).toEqual([
      "1 citation was removed because the source could not be verified.",
      "No model citation passed source validation; review the retrieved transcript moments directly.",
    ]);
  });

  it("does not manufacture citations when the model returns none", () => {
    const resolved = validateAnswerCitations(answer([]), [source(1), source(2), source(3)]);

    expect(resolved.answer.citations).toEqual([]);
    expect(resolved.validation).toEqual({
      requested: 0,
      verified: 0,
      rejected: 0,
      duplicates: 0,
      missing: true,
    });
    expect(resolved.answer.caveats[0]).toBe(
      "No model citation passed source validation; review the retrieved transcript moments directly.",
    );
  });

  it("keeps valid citations, removes invalid ones, and reports the exact counts", () => {
    const resolved = validateAnswerCitations(
      answer([modelCitation("1"), modelCitation("not-real"), modelCitation("3")]),
      [source(1), source(2), source(3)],
    );

    expect(resolved.answer.citations.map((citation) => citation.title)).toEqual([
      "Retrieved title 1",
      "Retrieved title 3",
    ]);
    expect(resolved.validation).toEqual({
      requested: 3,
      verified: 2,
      rejected: 1,
      duplicates: 0,
      missing: false,
    });
    expect(resolved.answer.caveats[0]).toBe(
      "1 citation was removed because the source could not be verified.",
    );
  });

  it("deduplicates the same source without replacing it and allows distinct clips from one video", () => {
    const first = source(1, { video_id: "shared-video" });
    const second = source(2, { video_id: "shared-video" });
    const resolved = validateAnswerCitations(
      answer([modelCitation("1"), modelCitation("source 1"), modelCitation("2")]),
      [first, second],
    );

    expect(resolved.answer.citations.map((citation) => citation.title)).toEqual([
      first.title,
      second.title,
    ]);
    expect(resolved.validation).toEqual({
      requested: 3,
      verified: 2,
      rejected: 0,
      duplicates: 1,
      missing: false,
    });
  });

  it("preserves existing caveats while prioritizing citation-validation disclosure", () => {
    const resolved = validateAnswerCitations(
      answer([modelCitation("invalid")], ["Evidence was narrow.", "Position was ambiguous."]),
      [source(1)],
    );

    expect(resolved.answer.caveats).toEqual([
      "1 citation was removed because the source could not be verified.",
      "No model citation passed source validation; review the retrieved transcript moments directly.",
      "Evidence was narrow.",
      "Position was ambiguous.",
    ]);
  });

  it("does not claim missing validation when there were no retrieved sources", () => {
    const resolved = validateAnswerCitations(answer([]), []);

    expect(resolved.validation.missing).toBe(false);
    expect(resolved.answer.caveats).toEqual([]);
  });
});
