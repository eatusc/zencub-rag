export type RagSearchResult = {
  id: string;
  video_id: string;
  chunk_index: number;
  start_seconds: number | string | null;
  end_seconds: number | string | null;
  text: string;
  metadata: {
    video_title?: string | null;
    video_url?: string | null;
    platform?: string | null;
    channel_name?: string | null;
    instructor_name?: string | null;
    thumbnail_url?: string | null;
    slug?: string | null;
    citation?: string | null;
  } | null;
  rank: number;
};

export type RagSearchResponse = {
  query: string;
  results: RagSearchResult[];
};
