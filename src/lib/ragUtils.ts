import type { RagSearchResult } from "@/lib/types";

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

export function formatRagSource(row: RagSearchResult, index: number): RagSource {
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
  };
}
