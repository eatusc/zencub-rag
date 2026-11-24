-- Relaxed (any-term) keyword search for transcript chunks.
--
-- search_rag_transcript_chunks uses plainto_tsquery, which ANDs every word and
-- drops "or" as a stop word, so a long or joined query can match nothing. This
-- additive function ORs the terms instead and ranks chunks by how many distinct
-- terms they contain, then by ts_rank. The existing function is unchanged.
--
-- Performance: an OR of common words can match half the corpus (7,022 of
-- 14,274 chunks for a 6-word side control follow-up), and re-parsing that much
-- text to rank it hit the API statement timeout. So coverage is counted from
-- one GIN index lookup per term (no text parsing), only the top 300 chunks by
-- coverage are parsed for ts_rank, and ties at that boundary break by id.
-- Worst case measured: 9 terms, 339 ms.
--
-- Safety: each term is stripped to ASCII letters and digits and turned into a
-- lexeme by plainto_tsquery before any tsquery text is assembled, so user input
-- never reaches tsquery syntax. At most 12 terms. Service role only.

CREATE OR REPLACE FUNCTION public.search_rag_transcript_chunks_any(
  terms text[],
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
  rank double precision,
  matched_terms integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH cleaned AS (
    SELECT DISTINCT lower(regexp_replace(t, '[^A-Za-z0-9]', '', 'g')) AS term
    FROM unnest(coalesce(terms, '{}'::text[])) AS t
  ),
  lexemes AS (
    SELECT DISTINCT plainto_tsquery('english', term)::text AS lexeme
    FROM cleaned
    WHERE term <> '' AND plainto_tsquery('english', term)::text <> ''
    LIMIT 12
  ),
  combined AS (
    SELECT string_agg(lexeme, ' | ')::tsquery AS any_query FROM lexemes
  ),
  coverage AS (
    SELECT hit.id, count(*)::integer AS matched_terms
    FROM lexemes l
    CROSS JOIN LATERAL (
      SELECT c.id
      FROM public.rag_transcript_chunks c
      WHERE to_tsvector('english', c.text) @@ l.lexeme::tsquery
    ) AS hit
    GROUP BY hit.id
  ),
  shortlist AS (
    SELECT cv.id, cv.matched_terms
    FROM coverage cv
    ORDER BY cv.matched_terms DESC, cv.id
    LIMIT 300
  )
  SELECT
    c.id,
    c.video_id,
    c.chunk_index,
    c.start_seconds,
    c.end_seconds,
    c.text,
    c.metadata,
    ts_rank(to_tsvector('english', c.text), combined.any_query)::double precision AS rank,
    s.matched_terms
  FROM shortlist s
  JOIN public.rag_transcript_chunks c ON c.id = s.id
  CROSS JOIN combined
  ORDER BY s.matched_terms DESC, rank DESC, c.video_id, c.chunk_index
  LIMIT LEAST(GREATEST(match_count, 1), 100);
$$;

REVOKE ALL ON FUNCTION public.search_rag_transcript_chunks_any(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_rag_transcript_chunks_any(text[], integer) TO service_role;
