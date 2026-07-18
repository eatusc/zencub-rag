-- ZenCub RAG — Phase 3 approval notes and Phase 4 recovery-test telemetry.
-- All objects are restricted to the RAG test area.

CREATE TABLE IF NOT EXISTS public.rag_research_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_key uuid NOT NULL UNIQUE,
  thread_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  review_action text NOT NULL CHECK (review_action IN ('approve', 'edit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_research_notes_thread_idx
  ON public.rag_research_notes (thread_id, created_at DESC);

ALTER TABLE public.rag_research_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_research_notes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rag_research_notes TO service_role;

CREATE TABLE IF NOT EXISTS public.rag_langgraph_test_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id uuid NOT NULL,
  node text NOT NULL,
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_langgraph_test_events_thread_idx
  ON public.rag_langgraph_test_events (thread_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS rag_langgraph_one_failure_per_node_idx
  ON public.rag_langgraph_test_events (thread_id, node, event)
  WHERE event = 'failure_injected';

ALTER TABLE public.rag_langgraph_test_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_langgraph_test_events FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.rag_langgraph_test_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.rag_langgraph_test_events_id_seq TO service_role;
