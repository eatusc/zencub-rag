-- ZenCub RAG — persistent search analytics
-- Run this once in the Supabase SQL editor for the app's project.

CREATE TABLE IF NOT EXISTS public.rag_search_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  query text NOT NULL CHECK (char_length(query) >= 2),
  action text NOT NULL CHECK (action IN ('keyword', 'semantic', 'analyze', 'ask', 'follow_up')),
  provider text CHECK (provider IS NULL OR provider IN ('qwen', 'openrouter', 'claude', 'openai')),
  retrieval text CHECK (retrieval IS NULL OR retrieval IN ('auto', 'text', 'vector', 'hybrid')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_search_logs_created_at_idx
  ON public.rag_search_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS rag_search_logs_action_created_at_idx
  ON public.rag_search_logs (action, created_at DESC);

ALTER TABLE public.rag_search_logs ENABLE ROW LEVEL SECURITY;

-- Search history stays server-only. The app writes with the service-role key;
-- browser clients cannot read or insert log rows directly.
REVOKE ALL ON TABLE public.rag_search_logs FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_search_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.rag_search_logs_id_seq TO service_role;

COMMENT ON TABLE public.rag_search_logs IS
  'Server-side log of keyword, semantic, analysis, Ask AI, and follow-up queries.';

-- Keep provider analytics aligned with the answer-engine selector. This also
-- upgrades projects that ran an earlier version of this migration.
ALTER TABLE public.rag_search_logs
  DROP CONSTRAINT IF EXISTS rag_search_logs_provider_check;
ALTER TABLE public.rag_search_logs
  ADD CONSTRAINT rag_search_logs_provider_check
  CHECK (provider IS NULL OR provider IN ('qwen', 'openrouter', 'claude', 'openai'));
