export function canRefineComparison(input: {
  qualityGapCount: number;
  refinementRound: number;
  maxRefinementRounds: number;
  // Whether the round that just ran actually closed any gap. A targeted
  // retrieval round that leaves the panel exactly as weak as it found it will
  // not do better on a second attempt: the usual gap is that the corpus holds
  // only one video of that instructor on the topic, which no query rewrite can
  // fix. Refining anyway costs another rerank and panel rebuild, measured at 31
  // seconds of a 114-second run. Optional and defaulting to true, so round zero
  // and callers with no history behave exactly as they did before.
  lastRoundClosedAGap?: boolean;
}): boolean {
  if (input.refinementRound > 0 && input.lastRoundClosedAGap === false) return false;
  return input.qualityGapCount > 0
    && input.refinementRound >= 0
    && input.refinementRound < input.maxRefinementRounds;
}
