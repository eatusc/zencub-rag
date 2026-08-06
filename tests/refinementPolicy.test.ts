import { describe, expect, it } from "vitest";
import { canRefineComparison } from "@/lib/langgraph/refinementPolicy";

describe("canRefineComparison", () => {
  it("permits the first and second repairs under the default two-round budget", () => {
    expect(canRefineComparison({
      qualityGapCount: 1,
      refinementRound: 0,
      maxRefinementRounds: 2,
    })).toBe(true);
    expect(canRefineComparison({
      qualityGapCount: 1,
      refinementRound: 1,
      maxRefinementRounds: 2,
    })).toBe(true);
  });

  it("stops exactly when the shared budget is exhausted", () => {
    expect(canRefineComparison({
      qualityGapCount: 1,
      refinementRound: 2,
      maxRefinementRounds: 2,
    })).toBe(false);
    expect(canRefineComparison({
      qualityGapCount: 4,
      refinementRound: 3,
      maxRefinementRounds: 2,
    })).toBe(false);
  });

  it("does not spend a repair round when there are no quality gaps", () => {
    expect(canRefineComparison({
      qualityGapCount: 0,
      refinementRound: 0,
      maxRefinementRounds: 2,
    })).toBe(false);
  });

  it("supports explicitly disabling refinement with a zero-round budget", () => {
    expect(canRefineComparison({
      qualityGapCount: 1,
      refinementRound: 0,
      maxRefinementRounds: 0,
    })).toBe(false);
  });

  it("rejects invalid negative round state defensively", () => {
    expect(canRefineComparison({
      qualityGapCount: 1,
      refinementRound: -1,
      maxRefinementRounds: 2,
    })).toBe(false);
  });
});

describe("canRefineComparison productivity guard", () => {
  it("stops refining once a round closes no gap", () => {
    // Round one found gaps and ran; round two found exactly as many, so the
    // targeted retrieval achieved nothing and a third attempt would not either.
    expect(canRefineComparison({
      qualityGapCount: 2,
      refinementRound: 1,
      maxRefinementRounds: 3,
      lastRoundClosedAGap: false,
    })).toBe(false);
  });

  it("keeps refining while rounds are still closing gaps", () => {
    expect(canRefineComparison({
      qualityGapCount: 1,
      refinementRound: 1,
      maxRefinementRounds: 3,
      lastRoundClosedAGap: true,
    })).toBe(true);
  });

  it("never blocks the first round, which has no previous round to judge", () => {
    expect(canRefineComparison({
      qualityGapCount: 2,
      refinementRound: 0,
      maxRefinementRounds: 2,
      lastRoundClosedAGap: false,
    })).toBe(true);
  });

  it("behaves as before when the caller reports nothing", () => {
    expect(canRefineComparison({
      qualityGapCount: 2,
      refinementRound: 1,
      maxRefinementRounds: 2,
    })).toBe(true);
  });
});
