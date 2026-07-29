export function canRefineComparison(input: {
  qualityGapCount: number;
  refinementRound: number;
  maxRefinementRounds: number;
}): boolean {
  return input.qualityGapCount > 0
    && input.refinementRound >= 0
    && input.refinementRound < input.maxRefinementRounds;
}
