# ZenCub RAG MCP Server

An MCP server that answers questions about the ZenCub BJJ corpus by querying the
database, instead of guessing from what a model remembers.

Status: **Phase 0 and Phase 1 done.** Seven tools live over stdio, registered
with Claude Code, 37 smoke-test assertions passing against the real database.
Phase 2 (semantic retrieval) is next. See [PLAN.md](PLAN.md) for the plan and
[LOG.md](LOG.md) for what actually happened.

## Layout

```
mcp/
  README.md      you are here: what this is, how to run it
  PLAN.md        the phased plan, locked decisions, open questions
  LOG.md         work log, newest at the bottom, evidence for every claim
  migrations/    SQL applied to the TEST database, numbered, one purpose each
  scripts/       verification and operational scripts
  src/           the server: db.ts, sqlGuard.ts, server.ts
  scripts/       verify-reader-role.sh, smoke-test.ts
```

## Database

**TEST only:** the Supabase project named by `RAG_TEST_PROJECT_REF` in
`.env.local`. Production is not a target for this repo. The server asserts the
project ref at startup against that variable rather than inheriting whatever the
environment happens to hold, and `verify-reader-role.sh` refuses to run against
anything else.

Project refs are deliberately absent from every tracked file here. This
repository is public, and the convention already exists: `.env.example` ships
`YOUR_PROJECT_REF`, and `.gitignore` excludes `docs/evals/*.json` for carrying
refs.

The server never uses `SUPABASE_SERVICE_ROLE_KEY` or `LANGGRAPH_DATABASE_URL`.
Both are owner-level: full read and write across all 61 tables in `public`,
covering user accounts, authentication, billing, and every other application
concern.
It uses `MCP_DATABASE_URL`, a dedicated `zencub_mcp_reader` role whose only
privilege in the database is SELECT on the `rag_mcp` view schema.

Scope is enforced by grants, not by inspecting SQL strings. A regex over SQL is
a guess; a role with no grant is a fact.

## What it exposes

Eight curated views in schema `rag_mcp`, created by
`migrations/0001-rag-mcp-schema-and-reader-role.sql`:

| View | Covers |
| --- | --- |
| `v_videos` | one row per video, with `has_transcript`, `chunk_count`, `technique_count` |
| `v_instructors` | people only, opt-outs excluded, with `attributed_video_count` |
| `v_creators` | all creator kinds, for channel and publisher questions |
| `v_video_instructors` | the uuid/text attribution join done correctly, confidence >= 0.7 |
| `v_techniques` | technique cards without the raw model payload |
| `v_chunks` | transcript evidence with metadata flattened, no embedding column |
| `v_search_logs` | public-site query telemetry, no IP or user identifier |
| `v_corpus_stats` | single-row summary so counting costs one cheap call |

## Tools

| Tool | What it answers |
| --- | --- |
| `describe_schema` | which view answers which question, with columns and types |
| `corpus_stats` | how big the corpus is, and when it was last synced |
| `query_sql` | anything countable: grouping, ranking, filtering |
| `get_video` | one video, its instructors, its techniques |
| `get_instructor` | one person, their videos, their position coverage |
| `list_techniques` | what the corpus covers, filtered |
| `get_transcript_window` | contiguous transcript between two timestamps |
| `health` | whether a failure is the server or the query |

There is deliberately no answer-generation tool. The MCP client is already a
model; this returns evidence and lets it synthesise.

`query_sql` runs inside `BEGIN TRANSACTION READ ONLY` against a role with no
write privilege anywhere. The keyword guard in `src/sqlGuard.ts` exists to
return a clear error, not to provide safety.

## Running it

```
claude mcp add zencub-rag --scope user -- \
  node --experimental-strip-types /ABSOLUTE/PATH/TO/mcp/src/server.ts
```

User scope rather than project scope on purpose: the path is machine-specific
and this repository is public.

Test it end to end at any time:

```
node --experimental-strip-types mcp/scripts/smoke-test.ts
```

## First-time setup

Already done on this machine. Repeat only for a fresh database.

1. Generate a password:

   ```
   openssl rand -base64 32
   ```

2. Edit `migrations/0001-rag-mcp-schema-and-reader-role.sql` and replace
   `REPLACE_WITH_GENERATED_PASSWORD`.

3. Apply it to the TEST database in the Supabase SQL editor, or with psql.

4. Add the reader credential to `.env.local`:

   ```
   MCP_DATABASE_URL=postgresql://ROLE:PASSWORD@HOST:5432/postgres
   ```

5. Verify:

   ```
   mcp/scripts/verify-reader-role.sh --live
   ```

   It enumerates the catalogue rather than checking a written-down list, and
   fails loudly if the role can read any relation outside `rag_mcp` or create
   a table. Paste its output into `LOG.md`.

## Known unknown

Whether the Supavisor pooler accepts a custom role as
`zencub_mcp_reader.<project-ref>` needs testing, not assuming. If it refuses,
the fallback is the project's direct host on port 5432, which needs IPv6 or the
IPv4 add-on. This is the one thing that could block Phase 0.
