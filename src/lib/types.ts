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
  similarity?: number;
};

export type RagSearchResponse = {
  query: string;
  results: RagSearchResult[];
};

export type RagAnalysisMoment = {
  rank: number;
  title: string;
  focus: string;
  why: string;
  start_seconds: number;
  end_seconds: number;
  citation: string;
  watch_url: string | null;
};

export type RagAnalysis = {
  summary: string;
  best_moments: RagAnalysisMoment[];
  key_details: string[];
  study_order: string[];
  next_searches: string[];
  caveats: string[];
};

export type RagAnalyzeResponse = {
  query: string;
  model: string;
  source_count: number;
  analysis: RagAnalysis;
};

export type RagAnswerCitation = {
  title: string;
  citation: string;
  start_seconds: number;
  end_seconds: number;
  watch_url: string | null;
};

export type RagAnswer = {
  answer: string;
  citations: RagAnswerCitation[];
  key_takeaways: string[];
  follow_up_searches: string[];
  caveats: string[];
};

export type RagAskResponse = {
  query: string;
  model: string;
  retrieval: "vector" | "text";
  source_count: number;
  answer: RagAnswer;
};
