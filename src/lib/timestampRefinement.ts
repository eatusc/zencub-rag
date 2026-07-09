import { createServerSupabase } from "@/lib/supabase";
import type { RagSearchResult } from "@/lib/types";

const CONTEXT_LEAD_SECONDS = 2;
const PASSAGE_SECONDS = 30;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "with",
  "you",
]);

type TranscriptSegment = {
  text?: unknown;
  offset?: unknown;
  start?: unknown;
  duration?: unknown;
  end?: unknown;
};

type TranscriptRow = {
  video_id: string;
  segments: unknown;
};

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedWords(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function significantQueryWords(query: string) {
  return normalizedWords(query).filter((word) => !STOP_WORDS.has(word));
}

function segmentStart(segment: TranscriptSegment) {
  return numeric(segment.offset) ?? numeric(segment.start);
}

function segmentEnd(segment: TranscriptSegment, start: number) {
  return numeric(segment.end) ?? start + (numeric(segment.duration) ?? 0);
}

function citationAt(row: RagSearchResult, startSeconds: number) {
  const title = row.metadata?.video_title ?? row.video_id;
  const total = Math.max(0, Math.floor(startSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${title} @ ${minutes}:${seconds}`;
}

function roundedSeconds(value: number) {
  return Math.round(value * 100) / 100;
}

function refineRow(query: string, row: RagSearchResult, rawSegments: unknown): RagSearchResult {
  if (!Array.isArray(rawSegments)) return row;

  const queryWords = significantQueryWords(query);
  if (queryWords.length === 0) return row;

  const chunkStart = numeric(row.start_seconds) ?? 0;
  const chunkEnd = numeric(row.end_seconds) ?? chunkStart;
  const queryWordSet = new Set(queryWords);
  const queryPhrase = queryWords.join(" ");
  const candidates = (rawSegments as TranscriptSegment[])
    .map((segment, index) => {
      const start = segmentStart(segment);
      if (start == null) return null;
      const end = segmentEnd(segment, start);
      if (end < chunkStart || start > chunkEnd) return null;

      // Caption segments are short and often overlap. Scoring a small local
      // window catches phrases split across adjacent caption boundaries.
      const windowText = (rawSegments as TranscriptSegment[])
        .slice(Math.max(0, index - 1), index + 2)
        .map((item) => typeof item.text === "string" ? item.text : "")
        .join(" ");
      const words = normalizedWords(windowText);
      const wordSet = new Set(words);
      const matched = [...queryWordSet].filter((word) => wordSet.has(word));
      const phraseMatch = queryWords.length > 1 && words.join(" ").includes(queryPhrase);
      const coverage = matched.length / queryWordSet.size;
      const confident = phraseMatch || coverage >= (queryWordSet.size === 1 ? 1 : 0.5);
      if (!confident) return null;

      return {
        start,
        end,
        score: (phraseMatch ? 20 : 0) + matched.length * 5 + coverage * 4,
      };
    })
    .filter((candidate): candidate is { start: number; end: number; score: number } => candidate != null)
    .sort((a, b) => b.score - a.score || a.start - b.start);

  const best = candidates[0];
  if (!best) return row;

  const refinedStart = roundedSeconds(Math.max(chunkStart, best.start - CONTEXT_LEAD_SECONDS));
  const refinedEnd = roundedSeconds(Math.min(chunkEnd, Math.max(best.end, refinedStart + PASSAGE_SECONDS)));
  return {
    ...row,
    start_seconds: refinedStart,
    end_seconds: refinedEnd,
    metadata: row.metadata
      ? {
          ...row.metadata,
          citation: citationAt(row, refinedStart),
        }
      : row.metadata,
  };
}

/**
 * Narrows coarse search-chunk timestamps to the raw caption segment that best
 * matches the query. Rows remain unchanged when there is no confident lexical
 * match, which keeps semantic-only results from receiving guessed timestamps.
 */
export async function refineResultTimestamps(query: string, rows: RagSearchResult[]) {
  const videoIds = [...new Set(rows.map((row) => row.video_id))];
  if (videoIds.length === 0) return rows;

  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_video_transcripts")
    .select("video_id,segments")
    .in("video_id", videoIds);

  if (error) return rows;

  const segmentsByVideo = new Map(
    ((data ?? []) as TranscriptRow[]).map((row) => [row.video_id, row.segments]),
  );
  return rows.map((row) => refineRow(query, row, segmentsByVideo.get(row.video_id)));
}
