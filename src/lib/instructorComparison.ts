import { createServerSupabase } from "@/lib/supabase";
import type { RagSearchResult } from "@/lib/types";

export type CanonicalInstructor = {
  slug: string;
  displayName: string;
  confidence: number;
  source: string;
};

export type AttributedCandidate = {
  row: RagSearchResult;
  instructor: CanonicalInstructor;
};

type VideoRow = {
  id: string;
  video_id: string;
};

type AttributionRow = {
  video_id: string;
  creator_slug: string;
  role: string;
  confidence: number | string;
  source: string;
};

type CreatorRow = {
  slug: string;
  display_name: string;
  kind: string | null;
  kind_override: string | null;
  opted_out_at: string | null;
};

export async function attributeCandidates(
  rows: RagSearchResult[],
  minimumConfidence = 0.7,
): Promise<{ attributed: AttributedCandidate[]; attributedVideoCount: number }> {
  const externalVideoIds = [...new Set(rows.map((row) => row.video_id))];
  if (externalVideoIds.length === 0) return { attributed: [], attributedVideoCount: 0 };

  const supabase = createServerSupabase();
  const { data: videoData, error: videoError } = await supabase
    .from("rag_videos")
    .select("id,video_id")
    .in("video_id", externalVideoIds);
  if (videoError) throw new Error(videoError.message);
  const videos = (videoData ?? []) as VideoRow[];
  const internalVideoIds = videos.map((video) => video.id);
  if (internalVideoIds.length === 0) return { attributed: [], attributedVideoCount: 0 };

  const { data: attributionData, error: attributionError } = await supabase
    .from("rag_video_attributions")
    .select("video_id,creator_slug,role,confidence,source")
    .in("video_id", internalVideoIds)
    .eq("role", "instructor")
    .gte("confidence", minimumConfidence);
  if (attributionError) throw new Error(attributionError.message);
  const attributions = (attributionData ?? []) as AttributionRow[];
  const creatorSlugs = [...new Set(attributions.map((row) => row.creator_slug))];
  if (creatorSlugs.length === 0) return { attributed: [], attributedVideoCount: 0 };

  const { data: creatorData, error: creatorError } = await supabase
    .from("rag_creators")
    .select("slug,display_name,kind,kind_override,opted_out_at")
    .in("slug", creatorSlugs)
    .is("opted_out_at", null);
  if (creatorError) throw new Error(creatorError.message);
  const creators = new Map(((creatorData ?? []) as CreatorRow[])
    .filter((creator) => (creator.kind_override ?? creator.kind) === "person")
    .map((creator) => [creator.slug, creator]));
  const externalByInternal = new Map(videos.map((video) => [video.id, video.video_id]));
  const bestByExternal = new Map<string, CanonicalInstructor>();

  for (const attribution of attributions.sort((a, b) => Number(b.confidence) - Number(a.confidence))) {
    const externalId = externalByInternal.get(attribution.video_id);
    const creator = creators.get(attribution.creator_slug);
    if (!externalId || !creator || bestByExternal.has(externalId)) continue;
    bestByExternal.set(externalId, {
      slug: creator.slug,
      displayName: creator.display_name,
      confidence: Number(attribution.confidence),
      source: attribution.source,
    });
  }

  return {
    attributed: rows.flatMap((row) => {
      const instructor = bestByExternal.get(row.video_id);
      return instructor ? [{ row, instructor }] : [];
    }),
    attributedVideoCount: bestByExternal.size,
  };
}

export function selectInstructorCandidates(
  rows: AttributedCandidate[],
  requestedInstructors: number,
  sourcesPerInstructor = 2,
): AttributedCandidate[][] {
  const selectedSlugs: string[] = [];
  const selectedNames: string[] = [];
  const nameParts = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/);
  const likelySamePerson = (left: string, right: string) => {
    const a = nameParts(left);
    const b = nameParts(right);
    if (a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-1)) return false;
    return a[0] === b[0] || a[0].startsWith(b[0]) || b[0].startsWith(a[0]);
  };
  for (const candidate of rows) {
    if (selectedSlugs.includes(candidate.instructor.slug)) continue;
    if (selectedNames.some((name) => likelySamePerson(name, candidate.instructor.displayName))) continue;
    selectedSlugs.push(candidate.instructor.slug);
    selectedNames.push(candidate.instructor.displayName);
    if (selectedSlugs.length === requestedInstructors) break;
  }

  return selectedSlugs.map((slug) => {
    const seenVideos = new Set<string>();
    return rows.filter((candidate) => {
      if (candidate.instructor.slug !== slug || seenVideos.has(candidate.row.video_id)) return false;
      seenVideos.add(candidate.row.video_id);
      return true;
    }).slice(0, sourcesPerInstructor);
  }).filter((group) => group.length > 0);
}
