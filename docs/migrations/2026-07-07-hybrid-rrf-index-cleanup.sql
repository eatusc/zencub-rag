-- ZenCub RAG — database-side retrieval upgrades
-- Run these in the Supabase SQL editor for your project.
-- The app implements RRF hybrid fusion, per-video diversity, degenerate-chunk
-- filtering, LLM reranking, and technique enrichment in application code
-- (src/lib/ragRetrieval.ts) because the app only has PostgREST access. The
-- statements below are the optional database-native versions: they move fusion
-- into Postgres and add the index/cleanup that need DDL/DML this app cannot run.

-- ---------------------------------------------------------------------------
-- 1. HNSW vector index (do before scaling past the current corpus)
-- At 12,104 rows a sequential scan is already fast, so this is a no-op for
-- latency today, but a production-scale corpus needs it. Cosine ops match the app's
-- match_rag_transcript_chunks similarity.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS rag_transcript_chunks_embedding_hnsw
  ON rag_transcript_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Full-text search index to keep the text path fast alongside it.
CREATE INDEX IF NOT EXISTS rag_transcript_chunks_text_fts
  ON rag_transcript_chunks
  USING gin (to_tsvector('english', text));

-- ---------------------------------------------------------------------------
-- 2. Optional: server-side hybrid search with Reciprocal Rank Fusion
-- Returns one fused ranking so the app can drop its two-call + JS-fusion path.
-- k = 60 is the standard RRF constant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hybrid_search_rag_chunks(
  query_text text,
  query_embedding vector,
  match_count int DEFAULT 20,
  rrf_k int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  video_id text,
  chunk_index int,
  start_seconds numeric,
  end_seconds numeric,
  text text,
  metadata jsonb,
  score double precision
)
LANGUAGE sql STABLE AS $$
  WITH vector_hits AS (
    SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> query_embedding) AS rank
    FROM rag_transcript_chunks c
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  text_hits AS (
    SELECT c.id,
           row_number() OVER (
             ORDER BY ts_rank(to_tsvector('english', c.text),
                              websearch_to_tsquery('english', query_text)) DESC
           ) AS rank
    FROM rag_transcript_chunks c
    WHERE to_tsvector('english', c.text) @@ websearch_to_tsquery('english', query_text)
    LIMIT match_count * 2
  ),
  fused AS (
    SELECT id, SUM(1.0 / (rrf_k + rank)) AS score
    FROM (
      SELECT id, rank FROM vector_hits
      UNION ALL
      SELECT id, rank FROM text_hits
    ) s
    GROUP BY id
  )
  SELECT c.id, c.video_id, c.chunk_index, c.start_seconds, c.end_seconds,
         c.text, c.metadata, f.score
  FROM fused f
  JOIN rag_transcript_chunks c ON c.id = f.id
  -- Skip degenerate fragments (the app uses a ~120-char / ~30-token floor).
  WHERE length(btrim(c.text)) >= 120
  ORDER BY f.score DESC
  LIMIT match_count;
$$;

-- ---------------------------------------------------------------------------
-- 3. Optional: hard-delete degenerate chunks instead of filtering at read time
-- The app already filters chunks under ~120 chars, so this is only if you want
-- to shrink the corpus. Inspect first, then delete. DESTRUCTIVE and irreversible.
-- ---------------------------------------------------------------------------
-- SELECT count(*) FROM rag_transcript_chunks WHERE token_count < 30;   -- preview
-- DELETE FROM rag_transcript_chunks WHERE token_count < 30;            -- ~800 rows
