import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARE_MAX_REFINEMENT_ROUNDS,
  MAX_COMPARE_MAX_REFINEMENT_ROUNDS,
  parseComparisonRefinementRounds,
} from "@/lib/env";

describe("parseComparisonRefinementRounds", () => {
  it("defaults to two bounded repair rounds when unset or blank", () => {
    expect(parseComparisonRefinementRounds(undefined)).toBe(
      DEFAULT_COMPARE_MAX_REFINEMENT_ROUNDS,
    );
    expect(parseComparisonRefinementRounds("  ")).toBe(
      DEFAULT_COMPARE_MAX_REFINEMENT_ROUNDS,
    );
    expect(DEFAULT_COMPARE_MAX_REFINEMENT_ROUNDS).toBe(2);
  });

  it("accepts every supported integer value", () => {
    expect([0, 1, 2, 3].map((value) => parseComparisonRefinementRounds(String(value))))
      .toEqual([0, 1, 2, 3]);
  });

  it("clamps excessive and negative values to the safe range", () => {
    expect(parseComparisonRefinementRounds("99")).toBe(MAX_COMPARE_MAX_REFINEMENT_ROUNDS);
    expect(parseComparisonRefinementRounds("-4")).toBe(0);
  });

  it("truncates fractional values instead of allowing a fractional loop budget", () => {
    expect(parseComparisonRefinementRounds("2.9")).toBe(2);
  });

  it("falls back for malformed and non-finite values", () => {
    for (const value of ["many", "NaN", "Infinity", "-Infinity"]) {
      expect(parseComparisonRefinementRounds(value), value).toBe(
        DEFAULT_COMPARE_MAX_REFINEMENT_ROUNDS,
      );
    }
  });
});
