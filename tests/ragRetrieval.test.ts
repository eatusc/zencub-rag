import { describe, expect, it } from "vitest";
import {
  MAX_PER_VIDEO,
  MIN_CHUNK_CHARS,
  capPerVideo,
  filterDegenerate,
  rrfFuse,
} from "@/lib/ragRetrieval";
import type { RagSearchResult } from "@/lib/types";

function makeResult(overrides: Partial<RagSearchResult> & { id: string }): RagSearchResult {
  return {
    video_id: "video-1",
    chunk_index: 0,
    start_seconds: 0,
    end_seconds: 30,
    text: "x".repeat(MIN_CHUNK_CHARS),
    metadata: null,
    rank: 0,
    ...overrides,
  };
}

describe("filterDegenerate", () => {
  it("drops chunks shorter than MIN_CHUNK_CHARS", () => {
    const short = makeResult({ id: "short", text: "too short" });
    const exact = makeResult({ id: "exact", text: "y".repeat(MIN_CHUNK_CHARS) });
    const long = makeResult({ id: "long", text: "z".repeat(MIN_CHUNK_CHARS + 1) });

    expect(filterDegenerate([short, exact, long]).map((row) => row.id)).toEqual(["exact", "long"]);
  });

  it("counts trimmed length, not padded whitespace", () => {
    const padded = makeResult({ id: "padded", text: `  ${"a".repeat(MIN_CHUNK_CHARS - 10)}  ` });
    expect(filterDegenerate([padded])).toEqual([]);
  });

  it("treats empty text as degenerate", () => {
    expect(filterDegenerate([makeResult({ id: "empty", text: "" })])).toEqual([]);
  });
});

describe("rrfFuse", () => {
  it("ranks a row appearing in both lists above single-list rows", () => {
    const a = makeResult({ id: "a" });
    const b = makeResult({ id: "b" });
    const c = makeResult({ id: "c" });

    const fused = rrfFuse([
      [a, b],
      [b, c],
    ]);

    expect(fused[0].id).toBe("b");
    expect(fused.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("assigns descending RRF scores based on rank position", () => {
    const a = makeResult({ id: "a" });
    const b = makeResult({ id: "b" });

    const fused = rrfFuse([[a, b]], 60);

    expect(fused[0].rank).toBeCloseTo(1 / 61);
    expect(fused[1].rank).toBeCloseTo(1 / 62);
    expect(fused[0].rank).toBeGreaterThan(fused[1].rank);
  });

  it("deduplicates rows by id, keeping the first occurrence", () => {
    const first = makeResult({ id: "dup", chunk_index: 1 });
    const second = makeResult({ id: "dup", chunk_index: 2 });

    const fused = rrfFuse([[first], [second]]);

    expect(fused).toHaveLength(1);
    expect(fused[0].chunk_index).toBe(1);
  });

  it("returns an empty list for empty input", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });
});

describe("capPerVideo", () => {
  it("keeps at most the given number of rows per video, preserving order", () => {
    const rows = [
      makeResult({ id: "a1", video_id: "a" }),
      makeResult({ id: "a2", video_id: "a" }),
      makeResult({ id: "b1", video_id: "b" }),
      makeResult({ id: "a3", video_id: "a" }),
      makeResult({ id: "b2", video_id: "b" }),
    ];

    expect(capPerVideo(rows, 2).map((row) => row.id)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("defaults to MAX_PER_VIDEO", () => {
    const rows = Array.from({ length: MAX_PER_VIDEO + 2 }, (_, index) =>
      makeResult({ id: `chunk-${index}`, video_id: "same" }),
    );

    expect(capPerVideo(rows)).toHaveLength(MAX_PER_VIDEO);
  });

  it("passes through rows from distinct videos unchanged", () => {
    const rows = [
      makeResult({ id: "a", video_id: "a" }),
      makeResult({ id: "b", video_id: "b" }),
      makeResult({ id: "c", video_id: "c" }),
    ];

    expect(capPerVideo(rows, 1)).toEqual(rows);
  });
});
