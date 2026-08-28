-- ZenCub RAG MCP - a seventh content_kind, and a record of the second opinion
--
-- Target: the ZenCub TEST Supabase project, whose ref is `RAG_TEST_PROJECT_REF`
-- in .env.local. Production is not a target for this file.
--
-- Validate inside BEGIN; ... ROLLBACK; before applying, as with 0001 and 0002.
--
-- ── 1. Why a seventh value ──────────────────────────────────────────────────
--
-- Found 2026-08-28 by auditing the first classification run rather than by
-- reasoning about the taxonomy. The six values in 0002 were derived from
-- reading the *flagged* set, which was entirely grappling content. The corpus
-- also holds videos that are not about grappling at all, and that population
-- had no home, so the classifier picked the nearest exit and called them
-- `no_content`:
--
--   "THIS CHANGES EVERYTHING"        -> "the economy was booming. Capital good
--                                        orders at 3.3%"
--   "Brutally Honest Reaction After Taking Delivery of New Tesla Model 3"
--   "Songkran & Gomorrah: Bangkok"   -> a travel vlog
--   "BEST STREET BASKETBALL PK"      -> streetball
--
-- Every one of those is fluent English speech, so `no_content` is wrong by its
-- own definition ("essentially no intelligible speech"). The prompt says so
-- explicitly and the model overrode it, because none of the six fitted.
--
-- These are the `source = user_submitted` rows with NULL martial_arts_relevance
-- that PLAN.md documents: /api/user/import passes skipRelevanceCheck: true, so
-- nothing ever asked whether they were martial arts.
--
-- Excluding them was the right OUTCOME reached through a WRONG label, and a
-- label that is wrong for a knowable reason keeps being wrong in ways that
-- cannot be predicted. It had already blurred into a genuine false exclude:
-- "Technical Stand-up sweep" is garbled ASR of real instruction and was also
-- filed under no_content.
--
--   off_topic  the transcript is intelligible and is not about grappling,
--              martial arts or training at all. Finance, cars, travel, other
--              sports. Distinct from no_content (nothing to hear) and from
--              promotional (selling, but selling jiu-jitsu).
--
-- off_topic joins event_coverage and no_content as an excluded value.
--
-- ── 2. Why the verification columns ─────────────────────────────────────────
--
-- Classification runs in two passes: local Qwen over everything, then a paid
-- model over only the videos Qwen wants to EXCLUDE. A video is removed from
-- retrieval only if both agree, because a false exclude is the one error that
-- deletes content no query can then reach. Measured on 60 held-out videos,
-- Qwen and Haiku agree on the gate 59/60, and the single disagreement was a
-- Qwen false exclude -- which is exactly what the second pass catches.
--
-- The columns record that the second opinion happened and which model gave it.
-- content_kind_model keeps naming the model whose label is stored, so the two
-- are never conflated: NULL verified_model means "no second opinion", which is
-- a different statement from "verified and agreed".

BEGIN;

-- ── Widen the value set ─────────────────────────────────────────────────────

ALTER TABLE public.rag_videos
  DROP CONSTRAINT IF EXISTS rag_videos_content_kind_check;
ALTER TABLE public.rag_videos
  ADD CONSTRAINT rag_videos_content_kind_check
  CHECK (content_kind IS NULL OR content_kind IN (
    'instruction', 'training_advice', 'event_coverage', 'interview',
    'promotional', 'no_content', 'off_topic'
  ));

COMMENT ON COLUMN public.rag_videos.content_kind IS
  'What kind of content this video is, for retrieval gating: instruction | training_advice | event_coverage | interview | promotional | no_content | off_topic. Excluded from retrieval: event_coverage, no_content, off_topic. NULL means not yet classified, which is not the same as any value. Set by mcp/scripts/classify-content-kind.ts.';

-- ── Record the second opinion ───────────────────────────────────────────────

ALTER TABLE public.rag_videos
  ADD COLUMN IF NOT EXISTS content_kind_verified_model text,
  ADD COLUMN IF NOT EXISTS content_kind_verified_at timestamptz;

COMMENT ON COLUMN public.rag_videos.content_kind_verified_model IS
  'Model that gave a second opinion on an exclusion, or NULL if none was asked. NULL means no second opinion, which is not the same as verified-and-agreed. Only videos a first pass wanted to exclude are verified; a kept video costs nothing if it is wrong in the other direction.';
COMMENT ON COLUMN public.rag_videos.content_kind_verified_at IS
  'When the second opinion ran. A label older than the current prompt should be re-verified rather than trusted.';

-- ── Expose both to the MCP reader ───────────────────────────────────────────
--
-- Recreated in full for the same reason as 0002: CREATE OR REPLACE VIEW cannot
-- insert a column in the middle. Still deliberately NOT CASCADE, so a dependent
-- added since 0002 fails loudly rather than being silently dropped.
DROP VIEW IF EXISTS rag_mcp.v_videos;
CREATE VIEW rag_mcp.v_videos AS
SELECT
  v.video_id,
  v.title,
  v.slug,
  v.platform,
  v.channel_name,
  v.instructor_name,
  v.url AS video_url,
  v.thumbnail_url,
  v.duration_seconds,
  v.gi_nogi,
  v.martial_arts_relevance,
  v.content_kind,
  v.content_kind_confidence,
  v.content_kind_verified_model,
  v.status,
  v.source,
  v.transcript_source,
  v.save_count,
  v.stack_count,
  COALESCE(c.chunk_count, 0) AS chunk_count,
  COALESCE(t.technique_count, 0) AS technique_count,
  (c.chunk_count IS NOT NULL) AS has_transcript,
  v.created_at
FROM public.rag_videos v
LEFT JOIN (
  SELECT video_id, COUNT(*)::int AS chunk_count
  FROM public.rag_transcript_chunks
  GROUP BY video_id
) c ON c.video_id = v.video_id
LEFT JOIN (
  SELECT video_id, COUNT(*)::int AS technique_count
  FROM public.rag_techniques
  GROUP BY video_id
) t ON t.video_id = v.video_id;

COMMENT ON VIEW rag_mcp.v_videos IS
  'One row per video in the corpus. Use has_transcript = true for the searchable corpus (~2,845); the full table (~3,032) includes videos with no transcript. content_kind is NULL until classified and is not a substitute for martial_arts_relevance: they answer different questions. Retrieval excludes event_coverage, no_content and off_topic. content_kind_verified_model is NULL unless a second model was asked to confirm an exclusion.';

GRANT SELECT ON rag_mcp.v_videos TO zencub_mcp_reader;

COMMIT;
