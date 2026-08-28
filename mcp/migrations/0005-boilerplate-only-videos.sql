-- ZenCub RAG MCP - correct the videos whose transcript is only boilerplate
--
-- WHY
--
-- Six videos are labelled with a KEPT content_kind and are retrievable today,
-- while their entire transcript is a channel tagline and a music marker. Found
-- 2026-08-28 by auditing the KEEP direction (mcp/scripts/classify-content-kind.ts
-- --audit-keeps), which the two-pass classification deliberately leaves
-- unchecked; see PLAN.md Phase 5 Tier 1 step 4b.
--
-- Every one was read before this file was written. Their complete transcripts:
--
--   7184507433933507886  instruction      masonfowlerbjj   "Let's go!"
--   7314008769166544174  instruction      Jiu Jitsu FLO    music-note outro marker
--   Ch6lZy4BhZY          instruction      Kameron Ross     "[Music] you"
--   o6TlGbv-rPs          promotional      BJJ Fanatics     "[music] >> Learn from the best on bjjfanatics.com."
--   7626785949459991821  training_advice  Jiu Jitsu FLO    "Thanks for watching!"
--   7627692312868424973  training_advice  kevinsjiujitsu   "It is time."
--
-- Those six prior labels are the record needed to reverse this.
--
-- What fooled the classifier is worth keeping: each of these carries an
-- enormous title holding a full technique description -- "Use the lasso guard
-- to bait your opponent into an omoplata attack. Here I let him pass in order
-- to invert and enter the omoplata position." over the transcript "Let's go!".
-- The prompt explicitly warns that titles in this corpus lie, and the model
-- followed the title anyway. mcp/scripts/classify-content-kind.ts now decides
-- this class deterministically, before any model call, so it cannot recur on
-- the next classification pass. This file fixes the rows already written.
--
-- SCOPE
--
-- Set-based and stated as the rule rather than as six ids, so it cannot hit a
-- row that does not meet the rule, and running it twice is a no-op. It can only
-- move a video INTO no_content: rows already in an excluded class are left
-- alone, so this can never return anything to the corpus.
--
-- Measured over the whole corpus: 97 videos have under 25 characters of speech
-- left after stripping, 90 of which the classifier already called no_content.
-- The threshold is not doing the classifier's job for it; it is catching the
-- handful the titles fooled it on.
--
-- Validate inside BEGIN; ... ROLLBACK; before applying, as with every migration
-- in this directory.

BEGIN;

WITH t AS (
  SELECT video_id, string_agg(text, ' ' ORDER BY chunk_index) AS body
    FROM public.rag_transcript_chunks
   GROUP BY video_id
), stripped AS (
  SELECT video_id,
         btrim(
           regexp_replace(
             regexp_replace(
               body,
               'Learn from the best on bjjfanatics\.com\.?|\[music\]|\[applause\]|>>|♪|♫|🎶',
               '', 'gi'),
             '\s+', ' ', 'g')
         ) AS rest
    FROM t
)
UPDATE public.rag_videos v
   SET content_kind = 'no_content',
       content_kind_confidence = 1,
       -- Keep the original model name and append the marker, so a guarded
       -- decision is never mistaken for something a model said. Same convention
       -- as GUARD_LABEL_SUFFIX in classify-content-kind.ts.
       content_kind_model = coalesce(v.content_kind_model, '') || '+boilerplate-guard',
       content_kind_at = now()
  FROM stripped s
 WHERE s.video_id = v.video_id
   AND length(s.rest) < 25
   AND v.content_kind IS NOT NULL
   AND v.content_kind NOT IN ('no_content', 'event_coverage', 'off_topic');

COMMIT;
