-- ZenCub RAG MCP - separate agent retrieval from site traffic in search logs
--
-- Target: the ZenCub TEST project named by RAG_TEST_PROJECT_REF. Production is
-- not a target for this file.
--
-- rag_search_logs.action is CHECK-constrained to five values, all of which mean
-- "a person did something on a website". /api/rag/search and
-- /api/rag/vector-search call logSearch themselves, so every MCP retrieval
-- already writes rows tagged 'keyword' and 'semantic' that are indistinguishable
-- from someone using search.zencub.com. Measured 2026-08-28: 119 such rows in
-- three hours, every one a test query from an agent session.
--
-- This widens the constraint to admit 'mcp', which /api/rag/retrieve writes.
-- Widening a CHECK cannot reject an existing row, so this is additive: no
-- backfill, no rewrite, and nothing that reads the table has to change. Queries
-- that want site traffic only should now say `action <> 'mcp'`; queries written
-- before this migration keep working unchanged, because no existing row is
-- relabelled.
--
-- The rows already written as 'keyword'/'semantic' by agent traffic are NOT
-- retroactively corrected. They are indistinguishable from real traffic by
-- construction, which is the point: the damage that has been done cannot be
-- undone, only stopped.

BEGIN;

ALTER TABLE public.rag_search_logs
  DROP CONSTRAINT IF EXISTS rag_search_logs_action_check;

ALTER TABLE public.rag_search_logs
  ADD CONSTRAINT rag_search_logs_action_check
  CHECK (action = ANY (ARRAY[
    'keyword'::text,
    'semantic'::text,
    'analyze'::text,
    'ask'::text,
    'follow_up'::text,
    'mcp'::text
  ]));

COMMENT ON COLUMN public.rag_search_logs.action IS
  'What produced this row. keyword/semantic/analyze/ask/follow_up are people on a site; mcp is retrieval served to the MCP server by /api/rag/retrieve. Filter on action <> ''mcp'' for human traffic.';

COMMIT;
