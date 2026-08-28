// Reassembling a contiguous transcript from overlapping chunks.
//
// Chunks are built with deliberate overlap so that a sentence spanning a
// boundary is retrievable from either side. Measured on the corpus, adjacent
// chunks share 6-8 seconds, which is roughly 150-250 characters of speech.
//
// get_transcript_window originally joined them with a space, so every boundary
// repeated a sentence:
//
//   "...progressively getting better and if it's not stop what you're doing.
//    progressively getting better and if it's not stop what you're doing.
//    Good morning coach."
//
// That is the same failure class as an empty result that should have had rows:
// the output is well formed, reads plausibly, and is wrong. A model quoting it
// would double a sentence, and a model judging emphasis would see a point made
// twice that was made once.

/** Collapse whitespace so an overlap that differs only in spacing still matches. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface Stitched {
  transcript: string;
  /** Characters trimmed at each boundary; index i is the join of chunk i to i+1. */
  overlaps: number[];
  /** Boundaries where no overlap was found and the join may still repeat. */
  unmatched_boundaries: number;
}

/**
 * Join chunks, removing the duplicated overlap at each boundary.
 *
 * Detection is on text, not timestamps, because mapping seconds onto character
 * offsets inside a chunk is a guess and the overlapping text is byte-identical:
 * both chunks are rendered from the same underlying segment list.
 *
 * `minOverlap` guards against trimming on a coincidental short match ("the ",
 * "and I"). A boundary whose overlap cannot be found is left intact and
 * counted, so a silent failure to trim shows up in the response rather than
 * looking like success.
 */
export function stitchTranscript(
  texts: string[],
  { maxOverlap = 800, minOverlap = 16 }: { maxOverlap?: number; minOverlap?: number } = {},
): Stitched {
  const parts = texts.map(normalise).filter((part) => part.length > 0);
  if (parts.length === 0) return { transcript: "", overlaps: [], unmatched_boundaries: 0 };

  let transcript = parts[0];
  const overlaps: number[] = [];
  let unmatched = 0;

  for (let i = 1; i < parts.length; i += 1) {
    const next = parts[i];
    const limit = Math.min(maxOverlap, transcript.length, next.length);
    let matched = 0;
    // Longest match first: a short tail can coincidentally repeat inside a
    // longer genuine overlap, and trimming the short one would leave the rest
    // duplicated.
    for (let k = limit; k >= minOverlap; k -= 1) {
      if (transcript.endsWith(next.slice(0, k))) {
        matched = k;
        break;
      }
    }
    if (matched === 0) unmatched += 1;
    overlaps.push(matched);
    // No trimStart and no added separator when something matched: the matched
    // span is a literal prefix of `next`, so whatever separates it from the
    // rest -- usually a single space -- is already sitting in the remainder.
    // Trimming it here is what glued "...choke" to "and then more".
    const remainder = next.slice(matched);
    if (matched > 0) transcript += remainder;
    else transcript += ` ${next}`;
  }

  return { transcript, overlaps, unmatched_boundaries: unmatched };
}
