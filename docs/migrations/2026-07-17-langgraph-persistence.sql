-- ZenCub RAG — LangGraph persistence namespace and telemetry update.
-- Run before `npm run langgraph:setup` when using a restricted database role.

CREATE SCHEMA IF NOT EXISTS langgraph;

-- The service-role HTTP API must not expose checkpoint state. LangGraph reaches
-- this schema only through LANGGRAPH_DATABASE_URL using the Postgres driver.
REVOKE ALL ON SCHEMA langgraph FROM anon, authenticated;

-- Exact checkpoint schema expected by @langchain/langgraph-checkpoint-postgres
-- 1.0.4. Recording migration versions makes the package's setup() idempotent.
CREATE TABLE IF NOT EXISTS langgraph.checkpoint_migrations (
  v integer PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoints (
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  parent_checkpoint_id text,
  type text,
  checkpoint jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_blobs (
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  channel text NOT NULL,
  version text NOT NULL,
  type text NOT NULL,
  blob bytea,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_writes (
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  task_id text NOT NULL,
  idx integer NOT NULL,
  channel text NOT NULL,
  type text,
  blob bytea NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

INSERT INTO langgraph.checkpoint_migrations (v)
VALUES (0), (1), (2), (3), (4)
ON CONFLICT (v) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA langgraph FROM anon, authenticated;

-- Phase 2 can report metadata-only retrieval when the keyword/vector branches
-- return no results but structured technique metadata does.
ALTER TABLE IF EXISTS public.rag_followup_experiment_runs
  DROP CONSTRAINT IF EXISTS rag_followup_experiment_runs_retrieval_check;

ALTER TABLE IF EXISTS public.rag_followup_experiment_runs
  ADD CONSTRAINT rag_followup_experiment_runs_retrieval_check
  CHECK (retrieval IS NULL OR retrieval IN ('text', 'vector', 'metadata', 'hybrid'));
