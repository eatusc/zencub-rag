-- ZenCub RAG — experimental LangGraph follow-up telemetry
-- Run this once in the Supabase SQL editor for the app's project.

CREATE TABLE IF NOT EXISTS public.rag_followup_experiment_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id uuid NOT NULL,
  turn_index integer NOT NULL CHECK (turn_index >= 1),
  query text NOT NULL CHECK (char_length(query) >= 2),
  requested_provider text NOT NULL
    CHECK (requested_provider IN ('qwen', 'openrouter', 'claude', 'openai')),
  actual_provider text
    CHECK (actual_provider IS NULL OR actual_provider IN ('qwen', 'openrouter', 'claude', 'openai')),
  model text,
  relationship text
    CHECK (relationship IS NULL OR relationship IN ('same_topic', 'new_topic')),
  retrieval text
    CHECK (retrieval IS NULL OR retrieval IN ('text', 'vector', 'hybrid')),
  source_count integer NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  conversation_turns integer NOT NULL DEFAULT 0 CHECK (conversation_turns >= 0),
  retained_context_sources integer NOT NULL DEFAULT 0 CHECK (retained_context_sources >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  trace jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trace) = 'array'),
  success boolean NOT NULL DEFAULT false,
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_followup_experiment_runs_created_at_idx
  ON public.rag_followup_experiment_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS rag_followup_experiment_runs_thread_idx
  ON public.rag_followup_experiment_runs (thread_id, turn_index);

CREATE INDEX IF NOT EXISTS rag_followup_experiment_runs_success_idx
  ON public.rag_followup_experiment_runs (success, created_at DESC);

ALTER TABLE public.rag_followup_experiment_runs ENABLE ROW LEVEL SECURITY;

-- Experiment details stay server-only. The service-role client writes the
-- measurements; browser clients cannot read or insert rows directly.
REVOKE ALL ON TABLE public.rag_followup_experiment_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_followup_experiment_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.rag_followup_experiment_runs_id_seq TO service_role;

COMMENT ON TABLE public.rag_followup_experiment_runs IS
  'Server-only telemetry for the opt-in LangGraph follow-up experiment.';

