-- ZenCub RAG — multi-turn Instructor Compare sessions and experiment branches.
-- The safe result remains server-only; LangGraph private state stays isolated in
-- the langgraph checkpoint schema.

ALTER TABLE public.rag_instructor_compare_runs
  ADD COLUMN IF NOT EXISTS turn_index integer NOT NULL DEFAULT 1 CHECK (turn_index > 0),
  ADD COLUMN IF NOT EXISTS relationship text NOT NULL DEFAULT 'initial'
    CHECK (relationship IN ('initial', 'follow_up')),
  ADD COLUMN IF NOT EXISTS parent_thread_id uuid;

ALTER TABLE public.rag_instructor_compare_runs
  DROP CONSTRAINT IF EXISTS rag_instructor_compare_runs_thread_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS rag_instructor_compare_runs_thread_turn_idx
  ON public.rag_instructor_compare_runs (thread_id, turn_index);

CREATE INDEX IF NOT EXISTS rag_instructor_compare_runs_parent_idx
  ON public.rag_instructor_compare_runs (parent_thread_id, created_at DESC)
  WHERE parent_thread_id IS NOT NULL;

REVOKE ALL ON TABLE public.rag_instructor_compare_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_instructor_compare_runs TO service_role;

COMMENT ON COLUMN public.rag_instructor_compare_runs.parent_thread_id IS
  'Original comparison thread when this result is a checkpoint experiment branch.';

CREATE TABLE IF NOT EXISTS public.rag_instructor_compare_branch_cache (
  thread_id uuid NOT NULL,
  turn_index integer NOT NULL CHECK (turn_index >= 0),
  refinement_round integer NOT NULL CHECK (refinement_round >= 0),
  instructor_slug text NOT NULL,
  analysis jsonb NOT NULL CHECK (jsonb_typeof(analysis) = 'object'),
  model_call jsonb NOT NULL CHECK (jsonb_typeof(model_call) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, turn_index, refinement_round, instructor_slug)
);

ALTER TABLE public.rag_instructor_compare_branch_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_instructor_compare_branch_cache FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_instructor_compare_branch_cache TO service_role;

COMMENT ON TABLE public.rag_instructor_compare_branch_cache IS
  'Server-only idempotency cache that prevents completed instructor model branches from rerunning during checkpoint recovery.';

-- Capabilities belong only in the active response and must never survive in
-- durable quality history, including rows written by pre-hardening builds.
UPDATE public.rag_instructor_compare_runs
SET result = result - 'session_token'
WHERE result ? 'session_token';
