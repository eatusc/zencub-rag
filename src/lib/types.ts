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
  channel: string | null;
  start_seconds: number;
  end_seconds: number;
  watch_url: string | null;
  thumbnail_url: string | null;
};

export type RagAnswer = {
  answer: string;
  citations: RagAnswerCitation[];
  key_takeaways: string[];
  follow_up_searches: string[];
  suggested_follow_up: string | null;
  caveats: string[];
};

export type RagConversationTurn = {
  question: string;
  answer: string;
};

export type RagTokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type RagAskResponse = {
  query: string;
  provider: import("@/lib/providers").AnswerProvider;
  model: string;
  retrieval: "vector" | "text" | "metadata" | "hybrid";
  reranked?: boolean;
  source_count: number;
  context_ids: string[];
  usage: RagTokenUsage | null;
  answer: RagAnswer;
};

// One executed node in the LangGraph run, surfaced so the UI can show the graph
// trace side-by-side with the classic pipeline.
export type RagGraphTraceEntry = {
  node: string;
  label: string;
  detail: string;
  ms: number;
};

export type RagGraphAskResponse = {
  query: string;
  engine: "langgraph";
  model: string;
  retrieval: "vector" | "text" | "hybrid";
  reranked: boolean;
  source_count: number;
  answer: RagAnswer;
  trace: RagGraphTraceEntry[];
  total_ms: number;
};

export type RagExperimentalFollowUpResponse = RagAskResponse & {
  engine: "langgraph";
  thread_id: string;
  turn_index: number;
  relationship: "same_topic" | "new_topic";
  trace: RagGraphTraceEntry[];
  total_ms: number;
};

export type RagComparisonClaim = {
  summary: string;
  citations: RagAnswerCitation[];
};

export type RagInstructorAnalysis = {
  creator_slug: string;
  creator_name: string;
  attribution_confidence: number;
  approach_summary: string;
  key_details: string[];
  best_for: string[];
  limitations: string[];
  citations: RagAnswerCitation[];
};

export type RagInstructorDifference = {
  subject: string;
  explanation: string;
  instructor_names: string[];
  citations: RagAnswerCitation[];
};

export type RagInstructorEvidenceClip = {
  id: number;
  creator_slug: string;
  creator_name: string;
  title: string;
  citation: string;
  start_seconds: number;
  end_seconds: number;
  watch_url: string | null;
};

export type RagInstructorPanelProposal = {
  kind: "instructor_panel_review";
  thread_id: string;
  query: string;
  refinement_round: number;
  instructors: Array<{
    creator_slug: string;
    creator_name: string;
    attribution_confidence: number;
    clips: RagInstructorEvidenceClip[];
  }>;
};

export type RagInstructorPanelDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "edit"; excluded_clip_ids: number[] };

export type RagComparisonQuality = {
  passed: boolean;
  score: number;
  refinement_rounds: number;
  max_refinement_rounds: number;
  gaps: string[];
};

export type RagClaimVerification = {
  claim_type: "shared_principle" | "difference";
  claim_index: number;
  summary: string;
  passed: boolean;
  instructor_count: number;
  citation_count: number;
  reason: string;
};

export type RagInstructorCompareResponse = {
  query: string;
  engine: "langgraph";
  thread_id: string;
  session_token?: string;
  provider: import("@/lib/providers").AnswerProvider;
  model: string;
  models: {
    semantic_embedding: string | null;
    evidence_reranker: string | null;
    instructor_analysis: string;
    synthesis: string;
    claim_verifier: string;
  };
  zero_paid_model_mode: boolean;
  usage: RagTokenUsage & {
    reported_calls: number;
    model_calls: Array<RagTokenUsage & {
      stage: "evidence_rerank" | "instructor_analysis" | "synthesis" | "claim_verification" | "targeted_retrieval";
      provider: import("@/lib/providers").AnswerProvider;
      model: string;
      ms: number;
    }>;
  };
  rerank_applied: boolean;
  retrieval: "vector" | "text" | "metadata" | "hybrid";
  instructor_count: number;
  evidence_count: number;
  attribution: {
    retrieved_candidates: number;
    attributed_candidates: number;
    minimum_confidence: number;
  };
  comparison: {
    topic: string;
    shared_principles: RagComparisonClaim[];
    instructors: RagInstructorAnalysis[];
    important_differences: RagInstructorDifference[];
    decision_guide: string[];
    caveats: string[];
  };
  session: {
    turn_index: number;
    relationship: "initial" | "follow_up";
    reused_evidence_count: number;
    parent_thread_id: string | null;
  };
  quality: RagComparisonQuality;
  claim_verifications: RagClaimVerification[];
  trace: RagGraphTraceEntry[];
  checkpoint_count: number;
  total_ms: number;
};

export type RagInstructorComparePausedResponse = {
  status: "paused";
  engine: "langgraph";
  thread_id: string;
  session_token: string;
  proposal: RagInstructorPanelProposal;
  trace: RagGraphTraceEntry[];
  checkpoint_count: number;
};

export type RagStoredInstructorCompareRun = RagInstructorCompareResponse & {
  stored_run_id: string;
  stored_at: string;
};
