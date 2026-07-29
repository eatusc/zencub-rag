import type { Technique } from "@/lib/ragRetrieval";
import type { RagAnswer, RagAnswerCitation, RagSearchResult } from "@/lib/types";

export type RagSource = {
  id: number;
  result_id?: string;
  video_id: string;
  title: string;
  citation: string;
  channel: string | null;
  thumbnail_url: string | null;
  start_seconds: number;
  end_seconds: number;
  source_url: string | null;
  watch_url: string | null;
  score: number;
  text: string;
  technique: string | null;
  position: string | null;
  difficulty: string | null;
  gi_nogi: string | null;
};

// The answer prompt asks for at most 3 citations. Validation runs over
// everything the model returned and this cap is applied to the survivors, so a
// model that over-cites cannot push valid citations out before they are checked.
export const MAX_DISPLAYED_CITATIONS = 3;

export type CitationValidation = {
  requested: number;
  verified: number;
  rejected: number;
  duplicates: number;
  truncated: number;
  missing: boolean;
};

export function asNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function timestampUrl(url: string | null | undefined, startSeconds: number) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const seconds = Math.max(0, Math.floor(startSeconds));
    if (parsed.hostname.includes("youtube.com")) {
      parsed.searchParams.set("t", `${seconds}s`);
      return parsed.toString();
    }
    if (parsed.hostname.includes("youtu.be")) {
      parsed.searchParams.set("t", String(seconds));
      return parsed.toString();
    }
  } catch {
    return url;
  }

  return url;
}

function youtubeThumbnailUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    let videoId: string | null = null;
    if (host === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      videoId = parsed.searchParams.get("v")
        ?? parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1]
        ?? null;
    }
    return videoId && /^[A-Za-z0-9_-]+$/.test(videoId)
      ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      : null;
  } catch {
    return null;
  }
}

function conciseAnswerText(value: string, maxWords = 140) {
  const text = value.trim();
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;

  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
  const kept: string[] = [];
  let wordCount = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.trim().split(/\s+/).length;
    if (wordCount + sentenceWords > maxWords) break;
    kept.push(sentence.trim());
    wordCount += sentenceWords;
  }

  return kept.length > 0
    ? kept.join(" ")
    : `${words.slice(0, maxWords).join(" ").replace(/[,:;]$/, "")}…`;
}

export function formatRagSource(row: RagSearchResult, index: number, technique?: Technique | null): RagSource {
  const start = asNumber(row.start_seconds);
  const end = asNumber(row.end_seconds);
  return {
    id: index + 1,
    result_id: row.id,
    video_id: row.video_id,
    title: row.metadata?.video_title ?? row.video_id,
    citation: row.metadata?.citation ?? `${row.video_id} @ ${Math.floor(start)}`,
    channel: row.metadata?.channel_name ?? row.metadata?.instructor_name ?? null,
    thumbnail_url: row.metadata?.thumbnail_url || youtubeThumbnailUrl(row.metadata?.video_url),
    start_seconds: start,
    end_seconds: end,
    source_url: row.metadata?.video_url ?? null,
    watch_url: timestampUrl(row.metadata?.video_url, start),
    score: row.rank ?? 0,
    text: row.text.slice(0, 1400),
    technique: technique?.technique_name ?? null,
    position: technique?.canonical_position ?? technique?.position ?? null,
    difficulty: technique?.difficulty ?? null,
    gi_nogi: technique?.gi_nogi ?? null,
  };
}

// Normalizes whatever the answer model returns into a well-formed RagAnswer.
// Shared by the classic /ask route and the LangGraph /graph-ask route so both
// engines are held to the exact same answer contract for a fair comparison.
export function coerceAnswer(value: unknown): RagAnswer {
  const fallback: RagAnswer = {
    answer: "No answer returned.",
    citations: [],
    key_takeaways: [],
    follow_up_searches: [],
    suggested_follow_up: null,
    caveats: ["The model did not return the expected JSON shape."],
  };

  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;

  return {
    answer: typeof raw.answer === "string" ? conciseAnswerText(raw.answer) : fallback.answer,
    citations: Array.isArray(raw.citations) ? raw.citations.slice(0, 8).map((citation) => {
      const primitive = typeof citation === "string" || typeof citation === "number" ? String(citation) : "";
      const item = citation && typeof citation === "object" ? citation as Record<string, unknown> : {};
      const reference = [item.citation, item.source_id, item.source, item.id, item.ref]
        .find((candidate): candidate is string | number => typeof candidate === "string" || typeof candidate === "number");
      return {
        title: typeof item.title === "string"
          ? item.title
          : typeof item.video_title === "string"
            ? item.video_title
            : primitive || "Untitled source",
        citation: reference !== undefined ? String(reference) : primitive || "No citation",
        channel: typeof item.channel === "string" ? item.channel : null,
        start_seconds: asNumber(item.start_seconds as number | string | null | undefined),
        end_seconds: asNumber(item.end_seconds as number | string | null | undefined),
        watch_url: typeof item.watch_url === "string" ? item.watch_url : null,
        thumbnail_url: typeof item.thumbnail_url === "string" ? item.thumbnail_url : null,
      };
    }) : [],
    key_takeaways: Array.isArray(raw.key_takeaways) ? raw.key_takeaways.filter((item): item is string => typeof item === "string").slice(0, 3) : [],
    follow_up_searches: Array.isArray(raw.follow_up_searches) ? raw.follow_up_searches.filter((item): item is string => typeof item === "string").slice(0, 3) : [],
    suggested_follow_up: typeof raw.suggested_follow_up === "string" && raw.suggested_follow_up.trim()
      ? raw.suggested_follow_up.trim().slice(0, 240)
      : null,
    caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((item): item is string => typeof item === "string").slice(0, 4) : [],
  };
}

// A displayed citation must resolve to one of the exact sources supplied to the
// answer model. Display metadata always comes from that retrieved database row;
// unmatched model output is removed rather than silently replaced by a
// different source.
export function validateAnswerCitations(
  answer: RagAnswer,
  sources: RagSource[],
): { answer: RagAnswer; validation: CitationValidation } {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const usedSources = new Set<number>();

  const toCitation = (source: RagSource): RagAnswerCitation => ({
    title: source.title,
    citation: source.citation,
    channel: source.channel,
    start_seconds: source.start_seconds,
    end_seconds: source.end_seconds,
    watch_url: source.watch_url,
    thumbnail_url: source.thumbnail_url || youtubeThumbnailUrl(source.source_url),
  });

  const findSource = (citation: RagAnswerCitation) => {
    const reference = normalize(citation.citation);
    const title = normalize(citation.title);
    return sources.find((candidate) => candidate.citation === citation.citation)
      ?? sources.find((candidate) => Boolean(citation.watch_url) && candidate.watch_url === citation.watch_url)
      ?? sources.find((candidate) => {
        const identifiers = [
          String(candidate.id),
          `source ${candidate.id}`,
          candidate.result_id ?? "",
          candidate.citation,
        ].map(normalize);
        return Boolean(reference) && identifiers.includes(reference);
      })
      // A bare video ID names a video, not a moment, and one video can supply
      // several retrieved clips. Require the cited timestamp to fall inside the
      // clip so the displayed link cannot point at a different moment.
      ?? sources.find((candidate) => Boolean(reference)
        && normalize(candidate.video_id) === reference
        && citation.start_seconds >= candidate.start_seconds - 1
        && citation.start_seconds <= candidate.end_seconds + 1)
      ?? sources.find((candidate) => title !== "untitled source"
        && title !== "no citation"
        && normalize(candidate.title) === title
        && citation.start_seconds >= candidate.start_seconds - 1
        && citation.start_seconds <= candidate.end_seconds + 1);
  };

  const resolvedSources: RagSource[] = [];
  let rejected = 0;
  let duplicates = 0;
  for (const citation of answer.citations) {
    const matched = findSource(citation);
    if (!matched) {
      rejected += 1;
      continue;
    }
    if (usedSources.has(matched.id)) {
      duplicates += 1;
      continue;
    }
    usedSources.add(matched.id);
    resolvedSources.push(matched);
  }
  // Cap the survivors, never the input: dropping the overflow here keeps the
  // "removed because the source could not be verified" caveat honest, because
  // a truncated citation was verified, it just did not fit the display limit.
  const displayed = resolvedSources.slice(0, MAX_DISPLAYED_CITATIONS);
  const verifiedCitations = displayed.map(toCitation);

  const validation: CitationValidation = {
    requested: answer.citations.length,
    verified: verifiedCitations.length,
    rejected,
    duplicates,
    truncated: resolvedSources.length - displayed.length,
    missing: verifiedCitations.length === 0 && sources.length > 0,
  };
  const validationCaveats: string[] = [];
  if (validation.rejected > 0) {
    validationCaveats.push(
      `${validation.rejected} citation${validation.rejected === 1 ? " was" : "s were"} removed because the source could not be verified.`,
    );
  }
  if (validation.missing) {
    validationCaveats.push("No model citation passed source validation; review the retrieved transcript moments directly.");
  }

  return {
    answer: {
      ...answer,
      citations: verifiedCitations,
      caveats: [...new Set([...validationCaveats, ...answer.caveats])].slice(0, 4),
    },
    validation,
  };
}
