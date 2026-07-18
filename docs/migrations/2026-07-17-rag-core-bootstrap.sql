-- ZenCub RAG — fresh-project bootstrap for a user-owned Supabase database.
--
-- Run this only when creating a new corpus database. It creates the minimum
-- application schema and retrieval RPCs expected by this repository. It does
-- not download videos, create transcripts, or populate copyrighted content.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.rag_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id text NOT NULL UNIQUE,
  title text,
  video_url text,
  platform text,
  channel_name text,
  thumbnail_url text,
  slug text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rag_video_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id text NOT NULL UNIQUE REFERENCES public.rag_videos(video_id) ON DELETE CASCADE,
  segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rag_creators (
  slug text PRIMARY KEY,
  display_name text NOT NULL,
  kind text,
  kind_override text,
  opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rag_video_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES public.rag_videos(id) ON DELETE CASCADE,
  creator_slug text NOT NULL REFERENCES public.rag_creators(slug) ON DELETE CASCADE,
  role text NOT NULL,
  confidence numeric NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, creator_slug, role)
);

CREATE TABLE IF NOT EXISTS public.rag_techniques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id text NOT NULL REFERENCES public.rag_videos(video_id) ON DELETE CASCADE,
  technique_name text,
  canonical_position text,
  position text,
  difficulty text,
  type text,
  gi_nogi text,
  start_seconds numeric,
  end_seconds numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rag_transcript_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id text NOT NULL REFERENCES public.rag_videos(video_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  start_seconds numeric,
  end_seconds numeric,
  text text NOT NULL CHECK (char_length(btrim(text)) > 0),
  token_count integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding extensions.vector(1536),
  embedded_at timestamptz,
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS rag_transcript_chunks_video_idx
  ON public.rag_transcript_chunks (video_id, chunk_index);
CREATE INDEX IF NOT EXISTS rag_transcript_chunks_text_fts
  ON public.rag_transcript_chunks
  USING gin (to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS rag_techniques_video_time_idx
  ON public.rag_techniques (video_id, start_seconds, end_seconds);
CREATE INDEX IF NOT EXISTS rag_video_attributions_video_idx
  ON public.rag_video_attributions (video_id, role, confidence DESC);

CREATE OR REPLACE FUNCTION public.search_rag_transcript_chunks(
  query_text text,
  match_count integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  video_id text,
  chunk_index integer,
  start_seconds numeric,
  end_seconds numeric,
  text text,
  metadata jsonb,
  rank double precision
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    c.id,
    c.video_id,
    c.chunk_index,
    c.start_seconds,
    c.end_seconds,
    c.text,
    c.metadata,
    ts_rank(
      to_tsvector('english', c.text),
      websearch_to_tsquery('english', query_text)
    )::double precision AS rank
  FROM public.rag_transcript_chunks c
  WHERE to_tsvector('english', c.text) @@ websearch_to_tsquery('english', query_text)
  ORDER BY rank DESC, c.video_id, c.chunk_index
  LIMIT LEAST(GREATEST(match_count, 1), 100);
$$;

CREATE OR REPLACE FUNCTION public.match_rag_transcript_chunks(
  query_embedding extensions.vector(1536),
  match_count integer DEFAULT 20,
  filter_video_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  video_id text,
  chunk_index integer,
  start_seconds numeric,
  end_seconds numeric,
  text text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT
    c.id,
    c.video_id,
    c.chunk_index,
    c.start_seconds,
    c.end_seconds,
    c.text,
    c.metadata,
    (1 - (c.embedding <=> query_embedding))::double precision AS similarity
  FROM public.rag_transcript_chunks c
  WHERE c.embedding IS NOT NULL
    AND (filter_video_id IS NULL OR c.video_id = filter_video_id)
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 100);
$$;

-- The app accesses corpus data only through its server-side service-role
-- client. Browser roles receive no direct table or RPC access.
ALTER TABLE public.rag_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_video_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_video_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_techniques ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_transcript_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_videos FROM anon, authenticated;
REVOKE ALL ON TABLE public.rag_video_transcripts FROM anon, authenticated;
REVOKE ALL ON TABLE public.rag_creators FROM anon, authenticated;
REVOKE ALL ON TABLE public.rag_video_attributions FROM anon, authenticated;
REVOKE ALL ON TABLE public.rag_techniques FROM anon, authenticated;
REVOKE ALL ON TABLE public.rag_transcript_chunks FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.search_rag_transcript_chunks(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_rag_transcript_chunks(extensions.vector, integer, text) FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_videos TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_video_transcripts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_creators TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_video_attributions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_techniques TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_transcript_chunks TO service_role;
GRANT EXECUTE ON FUNCTION public.search_rag_transcript_chunks(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_rag_transcript_chunks(extensions.vector, integer, text) TO service_role;
