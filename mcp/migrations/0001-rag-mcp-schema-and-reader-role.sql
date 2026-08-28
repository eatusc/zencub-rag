-- ZenCub RAG MCP - schema and reader role
--
-- Target: the ZenCub TEST Supabase project, whose ref is `RAG_TEST_PROJECT_REF`
-- in .env.local. The production project is NOT a target for this file or for
-- anything in this repository. Confirm the ref before running:
--   mcp/scripts/verify-reader-role.sh
-- refuses to run against any project other than the configured TEST one.
--
-- Creates a curated read-only surface for the MCP server, plus a login role
-- whose only privilege in the entire database is SELECT on that surface.
--
-- The point of the view layer is that scope is enforced by grants rather than
-- by inspecting SQL strings at runtime. The MCP server can be handed an
-- arbitrary SELECT and still be unable to read anything outside this schema:
-- not the application tables, not auth, not billing, because the role has no grant on
-- them and never did.
--
-- Views are owned by `postgres`, which owns the underlying tables, so they read
-- through RLS the same way the application's service-role client does. They are
-- deliberately NOT `security_invoker`.
--
-- Before running: replace REPLACE_WITH_GENERATED_PASSWORD below.
-- Generate with: openssl rand -base64 32

BEGIN;

-- ── 1. Schema ───────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS rag_mcp;
COMMENT ON SCHEMA rag_mcp IS
  'Read-only curated views over the rag_* corpus, exposed to the MCP server. No PII, no payment data, no embeddings.';

-- ── 2. Views ────────────────────────────────────────────────────────────────

-- One row per video. `has_transcript` matters: rag_videos holds ~3,032 rows but
-- only ~2,847 have transcripts and chunks, so "how many videos" has more than
-- one defensible answer and the caller has to be able to tell them apart.
CREATE OR REPLACE VIEW rag_mcp.v_videos AS
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
  'One row per video in the corpus. Use has_transcript = true for the searchable corpus (~2,847); the full table (~3,032) includes videos with no transcript.';

-- People only. A channel or publisher must never be presented as an instructor,
-- which is the rule src/lib/instructorComparison.ts already enforces in the app.
CREATE OR REPLACE VIEW rag_mcp.v_instructors AS
SELECT
  cr.slug,
  cr.display_name,
  cr.aliases,
  cr.canonical_link,
  cr.bio_short,
  cr.videos_as_instructor,
  cr.videos_as_guest,
  cr.techniques_count,
  COALESCE(a.attributed_video_count, 0) AS attributed_video_count
FROM public.rag_creators cr
LEFT JOIN (
  SELECT va.creator_slug, COUNT(DISTINCT va.video_id)::int AS attributed_video_count
  FROM public.rag_video_attributions va
  WHERE va.confidence >= 0.7
  GROUP BY va.creator_slug
) a ON a.creator_slug = cr.slug
WHERE COALESCE(cr.kind_override, cr.kind) = 'person'
  AND cr.opted_out_at IS NULL;

COMMENT ON VIEW rag_mcp.v_instructors IS
  'Human instructors only (effective kind = person, opt-outs excluded). ~266 of the 477 creator rows. Use this for any question about instructors or people.';

-- All creator kinds, for questions about channels and publishers. Opt-outs are
-- excluded here too: an opt-out is a request not to be featured, and it applies
-- whether the creator is a person or an organisation.
CREATE OR REPLACE VIEW rag_mcp.v_creators AS
SELECT
  cr.slug,
  cr.display_name,
  COALESCE(cr.kind_override, cr.kind) AS kind,
  cr.aliases,
  cr.canonical_link,
  cr.videos_as_instructor,
  cr.videos_as_guest,
  cr.techniques_count
FROM public.rag_creators cr
WHERE cr.opted_out_at IS NULL;

COMMENT ON VIEW rag_mcp.v_creators IS
  'All creators: person (~266), channel (~206), publisher (~5). For instructor questions use v_instructors instead.';

-- The uuid/text join, done once and correctly.
-- rag_video_attributions.video_id is the INTERNAL uuid (rag_videos.id), while
-- chunks and techniques key on the EXTERNAL text rag_videos.video_id. Joining
-- them naively returns zero rows, and that mistake is silent.
CREATE OR REPLACE VIEW rag_mcp.v_video_instructors AS
SELECT
  v.video_id,
  v.title AS video_title,
  cr.slug AS creator_slug,
  cr.display_name,
  COALESCE(cr.kind_override, cr.kind) AS kind,
  va.role,
  va.confidence,
  va.source AS attribution_source
FROM public.rag_video_attributions va
JOIN public.rag_videos v ON v.id = va.video_id
JOIN public.rag_creators cr ON cr.slug = va.creator_slug
WHERE va.confidence >= 0.7
  AND cr.opted_out_at IS NULL;

COMMENT ON VIEW rag_mcp.v_video_instructors IS
  'Video-to-creator attribution at confidence >= 0.7, already joined through the uuid/text boundary. Join to v_videos or v_chunks on video_id (text).';

-- Technique cards. raw_response and quality_flags are dropped: raw_response is
-- the full model payload and would dominate any result set.
CREATE OR REPLACE VIEW rag_mcp.v_techniques AS
SELECT
  t.id,
  t.video_id,
  t.video_title,
  t.channel_name,
  t.video_url,
  t.technique_name,
  t.canonical_position,
  t.position,
  t.sub_position,
  t.type,
  t.difficulty,
  t.gi_nogi,
  t.content_type,
  t.start_seconds,
  t.end_seconds,
  COALESCE(t.enriched_summary, t.summary) AS summary,
  COALESCE(t.enriched_steps, t.steps) AS steps,
  t.approval_status,
  t.slug,
  t.save_count,
  t.stack_count,
  t.created_at
FROM public.rag_techniques t;

COMMENT ON VIEW rag_mcp.v_techniques IS
  'Structured technique cards with timestamps. Join to v_videos on video_id. The steps column is jsonb and can be large; select it deliberately.';

-- Transcript chunks with the metadata jsonb flattened into columns.
-- The embedding column is deliberately absent: one row of 1536 floats is
-- roughly 30KB of context and is useless to a caller that cannot do vector math.
CREATE OR REPLACE VIEW rag_mcp.v_chunks AS
SELECT
  c.id,
  c.video_id,
  c.chunk_index,
  c.start_seconds,
  c.end_seconds,
  c.text,
  c.token_count,
  c.metadata ->> 'video_title'     AS video_title,
  c.metadata ->> 'channel_name'    AS channel_name,
  c.metadata ->> 'instructor_name' AS instructor_name,
  c.metadata ->> 'video_url'       AS video_url,
  c.metadata ->> 'platform'        AS platform,
  c.metadata ->> 'slug'            AS slug,
  c.metadata ->> 'citation'        AS citation,
  (c.embedding IS NOT NULL)        AS embedded,
  c.embedding_model
FROM public.rag_transcript_chunks c;

COMMENT ON VIEW rag_mcp.v_chunks IS
  'Timestamped transcript evidence, ~14,274 rows across ~2,847 videos, all embedded. The embedding vector itself is intentionally not exposed. For semantic relevance use the search_transcripts tool, not a LIKE over this view.';

-- Public-site query telemetry. No IP address, no user id, no session: the app
-- never records one (see src/lib/searchLogging.ts). `query` is text typed into
-- the public search box.
CREATE OR REPLACE VIEW rag_mcp.v_search_logs AS
SELECT
  l.id,
  l.query,
  l.action,
  l.provider,
  l.retrieval,
  (l.metadata ->> 'success')::boolean   AS success,
  (l.metadata ->> 'duration_ms')::int   AS duration_ms,
  (l.metadata ->> 'result_count')::int  AS result_count,
  l.metadata ->> 'model'                AS model,
  l.metadata ->> 'error_code'           AS error_code,
  l.metadata ->> 'surface'              AS surface,
  l.created_at
FROM public.rag_search_logs l;

COMMENT ON VIEW rag_mcp.v_search_logs IS
  'What people searched for on the public site, with latency and outcome. Contains no IP, user id, or session identifier.';

-- Precomputed summary so "how big is the corpus" costs one cheap call rather
-- than the caller inventing five aggregate queries and getting one of them wrong.
CREATE OR REPLACE VIEW rag_mcp.v_corpus_stats AS
SELECT
  (SELECT COUNT(*) FROM public.rag_videos)                                        AS videos_total,
  (SELECT COUNT(DISTINCT video_id) FROM public.rag_transcript_chunks)             AS videos_with_transcript,
  (SELECT COUNT(*) FROM public.rag_transcript_chunks)                             AS chunks_total,
  (SELECT COUNT(*) FROM public.rag_transcript_chunks WHERE embedding IS NOT NULL) AS chunks_embedded,
  (SELECT COUNT(*) FROM public.rag_techniques)                                    AS techniques_total,
  (SELECT COUNT(*) FROM public.rag_creators WHERE opted_out_at IS NULL
     AND COALESCE(kind_override, kind) = 'person')                                AS instructors_total,
  (SELECT COUNT(*) FROM public.rag_creators)                                      AS creators_total,
  (SELECT COUNT(*) FROM public.rag_video_attributions WHERE confidence >= 0.7)    AS attributions_total,
  (SELECT MAX(rag_synced_at) FROM public.rag_videos)                              AS corpus_synced_at;

COMMENT ON VIEW rag_mcp.v_corpus_stats IS
  'Single-row corpus summary. corpus_synced_at is when this TEST database was last refreshed from prod; answers describe the corpus as of that moment.';

-- ── 3. Reader role ──────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zencub_mcp_reader') THEN
    CREATE ROLE zencub_mcp_reader LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD';
  END IF;
END
$$;

COMMENT ON ROLE zencub_mcp_reader IS
  'MCP server. SELECT on schema rag_mcp only. No grants anywhere else, no write anywhere.';

-- Belt and braces on top of the grants: even a bug that opens a write
-- transaction fails, and a runaway query dies rather than holding a connection.
--
-- These DO take effect through the Supavisor pooler, verified on both 5432 and
-- 6543, but only because they are set here in the same transaction as CREATE
-- ROLE, before the role's first pooled connection exists.
--
-- ORDERING MATTERS. Measured 2026-08-27: once a role has connected through the
-- pooler, a later ALTER ROLE ... SET does not reach new connections for as long
-- as the pooled backend lives (still showing the old value after 60s of
-- retries). So treat these as set-once-at-creation. To change one later, expect
-- to recreate the role or wait out the pool rather than assume it applied.
--
-- Because of that, the server also enforces its own timeout and read-only
-- transaction in code. Not because this mechanism is broken, but because
-- anything we may want to tune should not depend on a setting that is awkward
-- to change. The grants below are the real boundary either way.
ALTER ROLE zencub_mcp_reader SET default_transaction_read_only = on;
ALTER ROLE zencub_mcp_reader SET statement_timeout = '5s';
ALTER ROLE zencub_mcp_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE zencub_mcp_reader SET search_path = rag_mcp;

-- ── 4. Grants: the actual security boundary ─────────────────────────────────

GRANT USAGE ON SCHEMA rag_mcp TO zencub_mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA rag_mcp TO zencub_mcp_reader;

-- Any view added to rag_mcp later is readable without revisiting this file.
ALTER DEFAULT PRIVILEGES IN SCHEMA rag_mcp
  GRANT SELECT ON TABLES TO zencub_mcp_reader;

-- Explicitly take away everything else. Most of this is already the default for
-- a fresh role, but stating it means the intent survives someone later granting
-- something broad to PUBLIC.
REVOKE ALL ON SCHEMA public FROM zencub_mcp_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM zencub_mcp_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM zencub_mcp_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM zencub_mcp_reader;
REVOKE ALL ON SCHEMA langgraph FROM zencub_mcp_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA langgraph FROM zencub_mcp_reader;

-- The role must not be able to create objects anywhere.
REVOKE CREATE ON SCHEMA public FROM zencub_mcp_reader;
REVOKE ALL ON DATABASE postgres FROM zencub_mcp_reader;
GRANT CONNECT ON DATABASE postgres TO zencub_mcp_reader;

COMMIT;
