-- ZenCub RAG — capability authorization for local/test checkpoint replay.
-- This table contains token hashes and replay provenance only. Checkpoint state
-- remains isolated in the non-PostgREST `langgraph` schema.

CREATE TABLE IF NOT EXISTS public.rag_langgraph_replay_threads (
  thread_id uuid PRIMARY KEY,
  access_token_hash text NOT NULL CHECK (char_length(access_token_hash) = 64),
  thread_kind text NOT NULL CHECK (thread_kind IN ('original', 'replay')),
  parent_thread_id uuid REFERENCES public.rag_langgraph_replay_threads(thread_id),
  source_checkpoint_id text,
  test_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (thread_kind = 'original' AND parent_thread_id IS NULL AND source_checkpoint_id IS NULL)
    OR
    (thread_kind = 'replay' AND parent_thread_id IS NOT NULL AND source_checkpoint_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS rag_langgraph_replay_threads_parent_idx
  ON public.rag_langgraph_replay_threads (parent_thread_id, created_at DESC);

ALTER TABLE public.rag_langgraph_replay_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_langgraph_replay_threads FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_langgraph_replay_threads TO service_role;
