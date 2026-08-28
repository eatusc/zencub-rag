#!/usr/bin/env bash
# Prove that zencub_mcp_reader can read the rag_mcp views and nothing else.
#
# Run this after applying migrations/0001, and again any time someone touches
# grants. It is deterministic: every row it prints is a privilege check the
# database itself answers, not a claim about what the code intends.
#
# Usage:
#   mcp/scripts/verify-reader-role.sh            # privilege matrix (needs owner creds)
#   mcp/scripts/verify-reader-role.sh --live     # also connects AS the reader role
#
# Owner credentials come from LANGGRAPH_DATABASE_URL in .env.local.
# The reader credential comes from MCP_DATABASE_URL.
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

: "${LANGGRAPH_DATABASE_URL:?set LANGGRAPH_DATABASE_URL in .env.local}"

# The expected project ref is never hardcoded: this repository is public, and
# RAG_TEST_PROJECT_REF is already the app's own guard (scripts/embed-rag-chunks.ts
# refuses to write unless the Supabase host matches it). Reuse it rather than
# inventing a second source of truth that can disagree with the first.
: "${RAG_TEST_PROJECT_REF:?set RAG_TEST_PROJECT_REF in .env.local}"

case "$LANGGRAPH_DATABASE_URL" in
  *"$RAG_TEST_PROJECT_REF"*) ;;
  *)
    echo "REFUSING: LANGGRAPH_DATABASE_URL does not point at the project named by" >&2
    echo "RAG_TEST_PROJECT_REF. Production is never a target for this repo." >&2
    exit 78
    ;;
esac

echo "==> Target: the project named by RAG_TEST_PROJECT_REF"
echo

echo "==> Positive: every rag_mcp view must be readable"
psql "$LANGGRAPH_DATABASE_URL" -c "
SELECT table_name,
       has_table_privilege('zencub_mcp_reader',
         format('%I.%I', table_schema, table_name), 'SELECT') AS can_select
FROM information_schema.views
WHERE table_schema = 'rag_mcp'
ORDER BY table_name;"

# Enumerated, not sampled. A hand-written deny-list goes stale the moment the
# app adds a table, and it would also print this database's table names into a
# public repository. Asking the catalogue is both a complete check and a silent
# one: it reports counts, never names.
echo "==> Negative: reachable relations OUTSIDE rag_mcp"
psql "$LANGGRAPH_DATABASE_URL" -c "
SELECT n.nspname AS schema,
       count(*) FILTER (WHERE has_table_privilege('zencub_mcp_reader', c.oid, 'SELECT')) AS readable,
       count(*) AS total
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','v','m','p','f')
  AND n.nspname NOT IN ('rag_mcp','pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_%'
GROUP BY n.nspname
HAVING count(*) FILTER (WHERE has_table_privilege('zencub_mcp_reader', c.oid, 'SELECT')) > 0
   OR n.nspname IN ('public','auth','langgraph','storage')
ORDER BY 1;"

# One known exception, and it is not ours to fix quietly. Supabase ships
# pg_stat_statements in the `extensions` schema with SELECT granted to PUBLIC,
# so every role in the database can read it, including this one. It exposes
# normalised query text (constants replaced by placeholders), not row data.
# Revoking it from PUBLIC is a database-wide change affecting every role, so it
# is a decision for the owner rather than a side effect of this script.
# Anything OTHER than that is a real failure.
echo "==> Failing on anything readable outside rag_mcp except the known exception"
UNEXPECTED=$(psql "$LANGGRAPH_DATABASE_URL" -At -c "
SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','v','m','p','f')
  AND n.nspname NOT IN ('rag_mcp','pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_%'
  AND has_table_privilege('zencub_mcp_reader', c.oid, 'SELECT')
  AND NOT (n.nspname = 'extensions' AND c.relname LIKE 'pg_stat_statements%');")

if [ "$UNEXPECTED" != "0" ]; then
  echo "FAIL: $UNEXPECTED relation(s) outside rag_mcp are readable by the role." >&2
  echo "      Run the negative query above without the exception clause to list them." >&2
  exit 1
fi
echo "    OK: nothing readable outside rag_mcp beyond pg_stat_statements."

echo "==> Schema privileges (expect CREATE = f everywhere)"
echo "    Note: USAGE on public is t and cannot be revoked per-role; Postgres"
echo "    grants it to PUBLIC. It confers name resolution only, and the negative"
echo "    check above proves no relation in it is actually readable."
psql "$LANGGRAPH_DATABASE_URL" -c "
SELECT s,
       has_schema_privilege('zencub_mcp_reader', s, 'USAGE')  AS usage,
       has_schema_privilege('zencub_mcp_reader', s, 'CREATE') AS create_
FROM (VALUES ('rag_mcp'),('public'),('auth'),('langgraph'),('storage')) x(s);"

echo "==> Write privileges on the readable schema (expect all f)"
psql "$LANGGRAPH_DATABASE_URL" -c "
SELECT obj,
       has_table_privilege('zencub_mcp_reader', obj,'INSERT') AS ins,
       has_table_privilege('zencub_mcp_reader', obj,'UPDATE') AS upd,
       has_table_privilege('zencub_mcp_reader', obj,'DELETE') AS del
FROM (VALUES ('rag_mcp.v_videos'),('rag_mcp.v_chunks'),('rag_mcp.v_techniques')) t(obj);"

echo "==> Role-level defaults (expect read-only txn + 5s statement timeout)"
psql "$LANGGRAPH_DATABASE_URL" -c "
SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolconfig
FROM pg_roles WHERE rolname = 'zencub_mcp_reader';"

if [ "${1:-}" = "--live" ]; then
  : "${MCP_DATABASE_URL:?set MCP_DATABASE_URL in .env.local to run --live}"
  echo
  echo "==> Live connection as the reader role"
  psql "$MCP_DATABASE_URL" -c "SELECT current_user, current_setting('default_transaction_read_only') AS read_only;"

  echo "--> allowed: corpus stats"
  psql "$MCP_DATABASE_URL" -c "SELECT * FROM rag_mcp.v_corpus_stats;"

  # Probe targets are read from the live catalogue rather than written down, so
  # this file names no table belonging to the application.
  for probe_schema in public auth; do
    target=$(psql "$LANGGRAPH_DATABASE_URL" -At -c "
      SELECT format('%I.%I', n.nspname, c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '$probe_schema' AND c.relkind = 'r'
        AND c.relname NOT LIKE 'rag_%'
      ORDER BY c.relname LIMIT 1;")
    [ -n "$target" ] || continue
    echo "--> must fail: a non-corpus table in $probe_schema"
    if psql "$MCP_DATABASE_URL" -c "SELECT count(*) FROM $target;" 2>/dev/null; then
      echo "FAIL: the reader role could read $target" >&2
      exit 1
    fi
    echo "    denied, as required"
  done

  echo "--> must fail: write"
  if psql "$MCP_DATABASE_URL" -c "CREATE TABLE rag_mcp.should_not_exist(x int);" 2>/dev/null; then
    echo "FAIL: the reader role could create a table" >&2
    exit 1
  fi
  echo "    denied, as required"
fi

echo
echo "==> Done. Paste this output into mcp/LOG.md."
