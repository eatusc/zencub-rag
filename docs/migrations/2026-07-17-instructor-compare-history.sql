-- ZenCub RAG — durable, server-only Instructor Compare result history.
-- Stores only the already-redacted API result; private retrieval candidates and
-- checkpoint state remain excluded.

CREATE TABLE IF NOT EXISTS public.rag_instructor_compare_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL UNIQUE,
  query text NOT NULL CHECK (char_length(query) BETWEEN 2 AND 1000),
  provider text NOT NULL CHECK (provider IN ('qwen', 'openrouter', 'openai')),
  model text NOT NULL,
  instructor_count integer NOT NULL CHECK (instructor_count BETWEEN 2 AND 5),
  evidence_count integer NOT NULL CHECK (evidence_count >= 0),
  total_ms integer NOT NULL CHECK (total_ms >= 0),
  prompt_tokens integer NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL CHECK (completion_tokens >= 0),
  total_tokens integer NOT NULL CHECK (total_tokens >= 0),
  shared_principle_count integer NOT NULL CHECK (shared_principle_count >= 0),
  difference_count integer NOT NULL CHECK (difference_count >= 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_instructor_compare_runs_created_idx
  ON public.rag_instructor_compare_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS rag_instructor_compare_runs_provider_created_idx
  ON public.rag_instructor_compare_runs (provider, created_at DESC);

ALTER TABLE public.rag_instructor_compare_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_instructor_compare_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_instructor_compare_runs TO service_role;

COMMENT ON TABLE public.rag_instructor_compare_runs IS
  'Server-only history of safe Instructor Compare API results for human quality review.';
