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

// Citation display metadata comes from the database, not the answer model. This
// keeps thumbnails and links reliable even when a provider returns only source
// IDs, citation strings, or malformed display fields.
export function hydrateAnswerCitations(answer: RagAnswer, sources: RagSource[]): RagAnswer {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const usedVideos = new Set<string>();

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
          candidate.video_id,
          candidate.citation,
        ].map(normalize);
        return Boolean(reference) && identifiers.includes(reference);
      })
      ?? sources.find((candidate) => title !== "untitled source"
        && title !== "no citation"
        && normalize(candidate.title) === title
        && citation.start_seconds >= candidate.start_seconds - 1
        && citation.start_seconds <= candidate.end_seconds + 1);
  };

  const hydrated: RagAnswerCitation[] = [];
  for (const [index, citation] of answer.citations.slice(0, 3).entries()) {
    const positional = sources[index];
    const matched = findSource(citation)
      ?? (positional && !usedVideos.has(positional.video_id) ? positional : undefined)
      ?? sources.find((candidate) => !usedVideos.has(candidate.video_id));
    if (!matched || usedVideos.has(matched.video_id)) continue;
    usedVideos.add(matched.video_id);
    hydrated.push(toCitation(matched));
  }

  // Some local models omit citations entirely. The top retrieved videos are
  // still the evidence supplied to the answer model, so expose them as refs.
  if (hydrated.length === 0) {
    let fallbackCount = 0;
    for (const source of sources) {
      if (usedVideos.has(source.video_id)) continue;
      usedVideos.add(source.video_id);
      hydrated.push(toCitation(source));
      fallbackCount += 1;
      if (fallbackCount === 3) break;
    }
  }

  return {
    ...answer,
    citations: hydrated,
  };
}
