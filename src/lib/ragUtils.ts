import type { Technique } from "@/lib/ragRetrieval";
import type { RagAnswer, RagSearchResult } from "@/lib/types";

export type RagSource = {
  id: number;
  result_id?: string;
  video_id: string;
  title: string;
  citation: string;
  channel: string | null;
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
    caveats: ["The model did not return the expected JSON shape."],
  };

  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;

  return {
    answer: typeof raw.answer === "string" ? raw.answer : fallback.answer,
    citations: Array.isArray(raw.citations) ? raw.citations.slice(0, 8).map((citation) => {
      const item = citation && typeof citation === "object" ? citation as Record<string, unknown> : {};
      return {
        title: typeof item.title === "string" ? item.title : "Untitled source",
        citation: typeof item.citation === "string" ? item.citation : "No citation",
        start_seconds: asNumber(item.start_seconds as number | string | null | undefined),
        end_seconds: asNumber(item.end_seconds as number | string | null | undefined),
        watch_url: typeof item.watch_url === "string" ? item.watch_url : null,
      };
    }) : [],
    key_takeaways: Array.isArray(raw.key_takeaways) ? raw.key_takeaways.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    follow_up_searches: Array.isArray(raw.follow_up_searches) ? raw.follow_up_searches.filter((item): item is string => typeof item === "string").slice(0, 6) : [],
    caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((item): item is string => typeof item === "string").slice(0, 4) : [],
  };
}
