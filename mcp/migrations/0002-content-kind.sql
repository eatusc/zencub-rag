-- ZenCub RAG MCP - content_kind classification column
--
-- Target: the ZenCub TEST Supabase project, whose ref is `RAG_TEST_PROJECT_REF`
-- in .env.local. Production is not a target for this file.
--
-- DRAFTED, NOT APPLIED. Same posture as 0001: validate inside
-- BEGIN; ... ROLLBACK; first, and apply only on an explicit decision, because
-- search.zencub.com and instructors.zencub.com read this database.
--
-- ── What this is for ────────────────────────────────────────────────────────
--
-- Neither of the two signals already in the corpus answers "should retrieval
-- return this", and the plan records why:
--
--   martial_arts_relevance answers "is there a technique to extract here". It
--   rejects coach AMAs and interviews that carry real practitioner advice, and
--   it is NULL for 150 videos (718 chunks) it never ran on at all, because
--   /api/user/import passes skipRelevanceCheck: true for every user submission.
--
--   technique_count answers "did extraction produce cards". It keeps
--   competition footage that happened to yield two cards and drops the Zahabi
--   AMAs and "7 Reasons Why Your Side Control Escapes Sucks", which are
--   instructional and produced none.
--
-- content_kind is the signal actually wanted. It is a LABEL, not a filter:
-- this migration changes no query behaviour anywhere. Nothing reads the column
-- until search_transcripts opts into it, which is a separate, revertible step.
--
-- ── Why the values are these values ─────────────────────────────────────────
--
-- Derived from reading the flagged set, all four buckets, 284 videos and 2,912
-- chunks, rather than from a taxonomy invented up front. The last two values
-- are not in the original plan and were added because the read found them:
--
--   instruction      someone is teaching a technique. Includes physical prep
--                    ("Foam Roller Work for Lower Extremity") and striking
--                    drills, which are instruction even where no BJJ technique
--                    card was extracted.
--   training_advice  practitioner-facing but not a technique: training
--                    longevity, injury, mindset, gym culture, coaching, belt
--                    progression, competition nerves. The Zahabi sciatic-pain
--                    AMA and the Chewjitsu training-partner questions live
--                    here. This is the category the relevance flag destroys.
--   event_coverage   match footage, highlights, brackets, results, vlogs,
--                    rankings shows. Confirmed worthless for retrieval by
--                    reading it: "Ladies and gentlemen, your winner by Chapo".
--   interview        conversation about the sport with a person: history,
--                    careers, news, MMA analysis. Kept, as a judgment call.
--   promotional      sales, seminars, merchandise, giveaways, book launches,
--                    "four spots left for my September camp".
--   no_content       the transcript carries no speech about the subject: song
--                    lyrics over silent footage, crowd noise, PA announcements
--                    in another language, [music] markers.
--
-- no_content is the one that cannot be skipped and cannot be shortcut. The
-- read found technique-promising titles whose entire transcript is song
-- lyrics: "Keenan Cornelius passing lapel guards" is five chunks of "♪♪";
-- Cobrinha's "Guard Passing Drills" is "I love you. I love you."; "Next level
-- Guard passing" is "The thing about the potato."; two "Lachy lock" videos are
-- rap verses. Those chunks are indexed, embedded, and retrievable today, and
-- can only ever be a wrong answer to a real question.
--
-- Measured 2026-08-28: text statistics do NOT find them. Bracket-marker ratio
-- and non-Latin script together flag 231 chunks in the whole corpus, and
-- repetition adds ~108 across the flagged set. Song lyrics are statistically
-- indistinguishable from speech, so this needs a model that reads the text.
-- A heuristic gate here would be another confident wrong answer.
--
-- ── Grain ───────────────────────────────────────────────────────────────────
--
-- Video level, matching martial_arts_relevance. Some videos are genuinely
-- mixed (an interview inside event coverage); confidence records that rather
-- than pretending the label is clean. Chunk-level classification is a later
-- decision and should be made on measured mixed-video counts, not assumed.

BEGIN;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.rag_videos
  ADD COLUMN IF NOT EXISTS content_kind text,
  ADD COLUMN IF NOT EXISTS content_kind_confidence numeric,
  ADD COLUMN IF NOT EXISTS content_kind_model text,
  ADD COLUMN IF NOT EXISTS content_kind_at timestamptz;

-- Nullable with no default on purpose. NULL means "not classified", which is a
-- different statement from any of the six values, and the 150 NULL
-- martial_arts_relevance rows are the standing proof that collapsing those two
-- meanings is how a gate silently mis-handles a population nobody knew about.
COMMENT ON COLUMN public.rag_videos.content_kind IS
  'What kind of content this video is, for retrieval gating: instruction | training_advice | event_coverage | interview | promotional | no_content. NULL means not yet classified, which is not the same as any value. Set by mcp/scripts/classify-content-kind.ts.';
COMMENT ON COLUMN public.rag_videos.content_kind_confidence IS
  'Classifier self-reported confidence 0-1. Low confidence usually means a genuinely mixed video, not a hard case.';
COMMENT ON COLUMN public.rag_videos.content_kind_model IS
  'Model that produced the label, so a reclassification can be scoped to one model rather than redoing the corpus.';

ALTER TABLE public.rag_videos
  DROP CONSTRAINT IF EXISTS rag_videos_content_kind_check;
ALTER TABLE public.rag_videos
  ADD CONSTRAINT rag_videos_content_kind_check
  CHECK (content_kind IS NULL OR content_kind IN (
    'instruction', 'training_advice', 'event_coverage', 'interview', 'promotional', 'no_content'
  ));

-- Partial: the overwhelming majority of lookups are "what is classified" and
-- "what is still NULL", and a full index on a mostly-one-of-six-values column
-- earns nothing.
CREATE INDEX IF NOT EXISTS rag_videos_content_kind_idx
  ON public.rag_videos (content_kind)
  WHERE content_kind IS NOT NULL;

-- ── 2. Expose it to the MCP reader ──────────────────────────────────────────

-- Recreated in full because CREATE OR REPLACE VIEW cannot add a column in the
-- middle, and appending would put the new columns after created_at where they
-- read as an afterthought.
--
-- Deliberately NOT CASCADE. Nothing depends on v_videos today (checked against
-- pg_depend on 2026-08-28, 0 dependents), so CASCADE would buy nothing now and
-- would silently drop a dependent view added between then and whenever this is
-- applied. A plain DROP fails loudly instead, which is the whole point.
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
  'One row per video in the corpus. Use has_transcript = true for the searchable corpus (~2,847); the full table (~3,032) includes videos with no transcript. content_kind is NULL until classified and is not a substitute for martial_arts_relevance: they answer different questions.';

GRANT SELECT ON rag_mcp.v_videos TO zencub_mcp_reader;

COMMIT;
