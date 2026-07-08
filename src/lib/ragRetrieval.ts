import OpenAI from "openai";
import { createServerSupabase } from "@/lib/supabase";
import type { RagSearchResult } from "@/lib/types";

// Minimum chunk length to be worth retrieving. ~30 tokens ≈ 120 chars.
// The corpus has ~419 chunks under 20 tokens and ~802 under 50 that are
// mostly transcription fragments; filtering them at read time keeps them out of
// results without a destructive delete.
export const MIN_CHUNK_CHARS = 120;

// How many candidates to pull from each retriever before fusing/reranking.
export const CANDIDATE_POOL = 20;
// How many fused+diverse candidates to feed the reranker.
export const RERANK_POOL = 12;
// Max chunks kept from any single video so top results show varied sources.
export const MAX_PER_VIDEO = 2;

export type Technique = {
  video_id: string;
  technique_name: string | null;
  canonical_position: string | null;
  position: string | null;
  difficulty: string | null;
  type: string | null;
  gi_nogi: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
};

export function filterDegenerate(rows: RagSearchResult[]): RagSearchResult[] {
  return rows.filter((row) => (row.text?.trim().length ?? 0) >= MIN_CHUNK_CHARS);
}

// Reciprocal Rank Fusion. Combines any number of ranked lists into one order
// using only each row's position, so it needs no score threshold and is robust
// to text-rank and cosine-similarity living on different scales.
// k=60 is the standard RRF constant.
export function rrfFuse(lists: RagSearchResult[][], k = 60): RagSearchResult[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, RagSearchResult>();

  for (const list of lists) {
    list.forEach((row, index) => {
      if (!byId.has(row.id)) byId.set(row.id, row);
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + index + 1));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...(byId.get(id) as RagSearchResult), rank: score }));
}

// Diversity guard: keep at most MAX_PER_VIDEO chunks from any one video so the
// top results are not three near-duplicate clips from the same upload.
export function capPerVideo(rows: RagSearchResult[], maxPerVideo = MAX_PER_VIDEO): RagSearchResult[] {
  const seen = new Map<string, number>();
  const out: RagSearchResult[] = [];
  for (const row of rows) {
    const used = seen.get(row.video_id) ?? 0;
    if (used >= maxPerVideo) continue;
    seen.set(row.video_id, used + 1);
    out.push(row);
  }
  return out;
}

// LLM reranker. Reorders candidates by true relevance to the query, which fixes
// the semantic-drift cases (e.g. defensive queries returning attack clips) that
// pure vector/text ranking gets wrong. Falls back to the input order on any
// error so retrieval never hard-fails on the rerank step.
export async function rerankWithLLM(
  query: string,
  rows: RagSearchResult[],
  openai: OpenAI,
  model: string,
  topK: number,
): Promise<RagSearchResult[]> {
  if (rows.length <= 1 || rows.length <= topK) return rows;

  try {
    const docs = rows.map((row, index) => ({
      index,
      title: row.metadata?.video_title ?? row.video_id,
      snippet: row.text.replace(/\s+/g, " ").trim().slice(0, 400),
    }));

    const completion = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You rank transcript chunks by how well they answer the user's query.",
            "Judge intent, not just keyword overlap: a query about defending or escaping a technique should rank defensive chunks above offensive ones.",
            "Return valid JSON only: { \"order\": number[] } listing the provided indices from most to least relevant.",
            "Include every index exactly once.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({ query, documents: docs }),
        },
      ],
    });

    const parsed = JSON.parse(completion.choices[0]?.message.content ?? "{}") as { order?: unknown };
    if (!Array.isArray(parsed.order)) return rows;

    const seen = new Set<number>();
    const ordered: RagSearchResult[] = [];
    for (const value of parsed.order) {
      const index = typeof value === "number" ? value : Number(value);
      if (Number.isInteger(index) && index >= 0 && index < rows.length && !seen.has(index)) {
        seen.add(index);
        ordered.push(rows[index]);
      }
    }
    // Append anything the model dropped so we never lose candidates.
    rows.forEach((row, index) => {
      if (!seen.has(index)) ordered.push(row);
    });
    return ordered;
  } catch {
    return rows;
  }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

// Attaches the structured technique (if any) whose timespan overlaps each chunk,
// turning "title @ 1:23" citations into "title @ 1:23 · Knee Cut Pass · Half
// Guard · Intermediate". Uses one batched query over the retrieved video ids.
export async function enrichWithTechniques(
  rows: RagSearchResult[],
): Promise<Array<{ row: RagSearchResult; technique: Technique | null }>> {
  const videoIds = [...new Set(rows.map((row) => row.video_id))];
  if (videoIds.length === 0) return rows.map((row) => ({ row, technique: null }));

  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_techniques")
    .select("video_id,technique_name,canonical_position,position,difficulty,type,gi_nogi,start_seconds,end_seconds")
    .in("video_id", videoIds);

  if (error) return rows.map((row) => ({ row, technique: null }));
  const techniques = (data ?? []) as Technique[];

  return rows.map((row) => {
    const start = Number(row.start_seconds) || 0;
    const end = Number(row.end_seconds) || start;
    const technique = techniques
      .filter((item) => item.video_id === row.video_id)
      .find((item) => overlaps(Number(item.start_seconds) || 0, Number(item.end_seconds) || 0, start, end)) ?? null;
    return { row, technique };
  });
}
