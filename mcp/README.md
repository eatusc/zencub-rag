# ZenCub RAG MCP Server

An MCP server that answers questions about the ZenCub BJJ corpus by querying the
database and the app's own retrieval pipeline, instead of guessing from what a
model remembers.

**Status: Phases 0-3 done and deployed. Phases 4 and 5 deliberately not
started.** Nine tools over stdio, registered with Claude Code. 60 smoke
assertions and 36 search assertions passing against the real database and the
live retrieval surface.

Two kinds of question, both served:

- **Content questions** ("what does Danaher say about the knee cut") go through
  `search_transcripts`, which calls the app's real hybrid pipeline.
- **Analytical questions** ("how many videos per instructor", "which positions
  are underrepresented") go through `query_sql` against curated views. No amount
  of chunk retrieval counts anything correctly.

See [PLAN.md](PLAN.md) for the reasoning and the open items, and [LOG.md](LOG.md)
for what actually happened, with evidence for every claim.

## Layout

```
mcp/
  README.md      you are here: what this is, how to run it
  PLAN.md        the phased plan, locked decisions, open questions
  LOG.md         work log, newest at the bottom, evidence for every claim
  migrations/    SQL applied to the TEST database, numbered, one purpose each
  src/           the server: server.ts, db.ts, search.ts, transcript.ts, sqlGuard.ts, enums.ts
  scripts/       verification, tests, and the content_kind classifier
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
Both are owner-level: full read and write across every table in `public`,
covering user accounts, authentication, billing, and every other application
concern. It uses `MCP_DATABASE_URL`, a dedicated `zencub_mcp_reader` role whose
only privilege in the database is SELECT on the `rag_mcp` view schema.

Scope is enforced by grants, not by inspecting SQL strings. A regex over SQL is
a guess; a role with no grant is a fact.

That credential decision is also why retrieval goes over HTTP rather than
importing the pipeline in-process: every retrieval function reaches the database
through `createServerSupabase()`, which is built from the service-role key, so
an in-process import would put that key inside the MCP process. See PLAN.md
Phase 2, Spike A.

## Migrations

All applied to TEST. Numbered, one purpose each, each validated inside
`BEGIN; ... ROLLBACK;` before being applied for real.

| File | What it does | Applied |
| --- | --- | --- |
| `0001-rag-mcp-schema-and-reader-role.sql` | schema `rag_mcp`, 8 curated views, the `zencub_mcp_reader` login role | 2026-08-27 |
| `0002-content-kind.sql` | `content_kind` + confidence/model/at columns on `rag_videos`, CHECK over six values, partial index | 2026-08-28 |
| `0003-search-log-mcp-action.sql` | widens the `rag_search_logs.action` CHECK to admit `mcp`, so this server's traffic stops polluting site analytics | 2026-08-28 |
| `0004-content-kind-off-topic-and-verification.sql` | a seventh value `off_topic`; `content_kind_verified_model` / `_at` so "checked and agreed" is distinguishable from "never checked" | 2026-08-28 |
| `0005-boilerplate-only-videos.sql` | corrects 6 videos whose whole transcript is a tagline and a music marker but which were labelled with a kept class | 2026-08-28 |

`0001` is the only one that needs a hand-edit before applying; see First-time
setup. The tracked file permanently carries `REPLACE_WITH_GENERATED_PASSWORD`.

## What it exposes

Eight curated views in schema `rag_mcp`, created by `0001`:

| View | Covers |
| --- | --- |
| `v_videos` | one row per video, with `has_transcript`, `chunk_count`, `technique_count`, `content_kind` |
| `v_instructors` | people only, opt-outs excluded, with `attributed_video_count` |
| `v_creators` | all creator kinds, for channel and publisher questions |
| `v_video_instructors` | the uuid/text attribution join done correctly, confidence >= 0.7 |
| `v_techniques` | technique cards without the raw model payload |
| `v_chunks` | transcript evidence with metadata flattened, no embedding column |
| `v_search_logs` | public-site query telemetry, no IP or user identifier |
| `v_corpus_stats` | single-row summary so counting costs one cheap call |

Two joins the views get right and a naive query gets wrong:
`rag_video_attributions.video_id` is the internal uuid while chunks and
techniques key on the external text id; and only creators whose effective kind
is `person` may be presented as instructors, or a channel like "BJJ Fanatics"
gets displayed as a human.

## Tools

| Tool | What it answers |
| --- | --- |
| `search_transcripts` | **what instructors actually said**, ranked by the app's own pipeline |
| `get_transcript_window` | contiguous transcript between two timestamps |
| `get_video` | one video, its instructors, its techniques |
| `get_instructor` | one person, their videos, their position coverage |
| `list_techniques` | what the corpus covers, filtered |
| `query_sql` | anything countable: grouping, ranking, filtering |
| `describe_schema` | which view answers which question, with columns and types |
| `corpus_stats` | how big the corpus is, and when it was last synced |
| `health` | whether a failure is the server, the app, or the query |

There is deliberately no answer-generation tool. The MCP client is already a
model; this returns evidence and lets it synthesise.

The chaining is the point. A single search tool that mirrors the website adds
nothing; every `search_transcripts` hit carries `video_id`, timestamps, an
instructor slug and a deep link, so the model can go straight to
`get_transcript_window` or `get_instructor` without another lookup.

### `search_transcripts` and the content gate

Ranking is the app's real pipeline -- hybrid fusion, LLM rerank, per-video
diversity, timestamp refinement -- reached over HTTP at
`http://127.0.0.1:3421/api/rag/retrieve`. **The server's own `fuse()` was
deleted rather than left behind a flag**: a second ranking implementation is
what produced the zipper bug where keyword results won every tie.

`filter` defaults to **`curated`**, which drops videos classified
`event_coverage`, `no_content` or `off_topic`, and keeps NULL because
unclassified is not a verdict. `filter: "none"` reproduces what
search.zencub.com returns today. The difference is not cosmetic: for
"heel hook defense", `none` returns a Polaris event broadcast at #1 and
`curated` returns the Leduc seminar.

`content_kind` is classified across the whole corpus (2,845 videos with chunks)
in two passes -- local Qwen over everything, then Haiku over only what pass 1
wanted to exclude. Current distribution:

| kind | videos | in `curated`? |
| --- | --- | --- |
| `instruction` | 2,110 | kept |
| `training_advice` | 182 | kept |
| `interview` | 109 | kept |
| `promotional` | 57 | kept |
| `no_content` | 244 | dropped |
| `event_coverage` | 119 | dropped |
| `off_topic` | 24 | dropped |

`query_sql` runs inside `BEGIN TRANSACTION READ ONLY` against a role with no
write privilege anywhere. The keyword guard in `src/sqlGuard.ts` exists to
return a clear error, not to provide safety.

## Running it

`search_transcripts` needs the loopback retrieval surface up; every other tool
needs only the database.

```
claude mcp add zencub-rag --scope user -- \
  node --experimental-strip-types /ABSOLUTE/PATH/TO/mcp/src/server.ts
```

User scope rather than project scope on purpose: the path is machine-specific
and this repository is public.

### The retrieval surface

`APP_MODE=mcp` on loopback **3421** (`scripts/deploy/serve.sh mcp`, run by
`local.zencub-rag-mcp`). It serves `/api/health` and `/api/rag/retrieve` and
404s everything else, including every page. It exists as its own deployment for
two reasons, both measured rather than assumed:

- `/api/rag/ask` cannot be reused. `consumeDailyAskBudget()` runs in middleware
  keyed on that pathname *before* the handler reads the body, so no request flag
  can opt out, and MCP retrieval would spend search.zencub.com's 2,000-a-day Ask
  allowance.
- It is never put behind the Cloudflare Tunnel. Retrieval costs an embedding
  plus a rerank per call with no spend cap, and `clientIp()` reads
  caller-supplied headers, so a loopback restriction at the application layer
  would be spoofable. Being unreachable from outside the machine is the control.

`/api/rag/retrieve` must stay 404 on the public (3418) and instructors (3420)
surfaces. `tests/deploymentGating.test.ts` holds that in both directions -- 31
cases covering which routes each surface serves, including that the new route is
absent from both public surfaces and that neither lost a route it had.

**`src/lib/ragPipeline.ts` is never modified.** `instructors.zencub.com` reaches
the same pipeline functions through `instructorCompareGraph` as a library
import, so the route layer is the only safe place to change retrieval behaviour.

## Tests

| Command | Asserts | Needs |
| --- | --- | --- |
| `node --experimental-strip-types mcp/scripts/smoke-test.ts` | 60 | database only |
| `node --experimental-strip-types mcp/scripts/search-test.ts` | 36 | the 3421 surface |
| `npm test` | 76 | nothing |
| `bash scripts/deploy/test-alerting.sh` | 35 | nothing, sends nothing |
| `npm run typecheck && npx eslint mcp src tests` | - | nothing |
| `mcp/scripts/verify-reader-role.sh --live` | privilege matrix | owner + reader creds |

Re-run `verify-reader-role.sh --live` after **any** migration that touches a
view or a grant. Recreating a view can drop its grants, and read access
continuing to work does not prove the deny side still holds.

Not a test, but useful: `mcp/scripts/curated-check.ts` prints `filter=none`
beside `filter=curated` for any queries passed as argv. It asserts nothing on
purpose -- the gate's value is a judgement about result quality that a pass
count cannot show.

## First-time setup

Already done on this machine. Repeat only for a fresh database.

1. Generate a password:

   ```
   openssl rand -base64 32
   ```

2. Copy `migrations/0001-rag-mcp-schema-and-reader-role.sql` to a temporary file
   and replace `REPLACE_WITH_GENERATED_PASSWORD` there. The tracked file keeps
   the placeholder; the real password lives only in `.env.local` and the
   database.

3. Apply the temporary copy to the TEST database, then delete it.

4. Add the reader credential to `.env.local`:

   ```
   MCP_DATABASE_URL=postgresql://ROLE:PASSWORD@HOST:5432/postgres
   ```

5. Apply `0002` through `0005` in order.

6. Verify:

   ```
   mcp/scripts/verify-reader-role.sh --live
   ```

   It enumerates the catalogue rather than checking a written-down list, so it
   cannot go stale as the app adds tables, and it fails loudly if the role can
   read any relation outside `rag_mcp` or create a table. Paste its output into
   `LOG.md`.

## Credentials

| Variable | Used by | Notes |
| --- | --- | --- |
| `MCP_DATABASE_URL` | the MCP server | the reader role; SELECT on `rag_mcp` and nothing else |
| `RAG_TEST_PROJECT_REF` | startup assertion | the server refuses to boot if the DSN does not match |
| `LANGGRAPH_DATABASE_URL` | migrations and the classifier only | owner. **Never** reaches the MCP process |
| `CONTENT_KIND_API_KEY` | the classifier only | its own key, deliberately |

`CONTENT_KIND_API_KEY` exists because the classifier used to fall back to
`OPENROUTER_API_KEY`, which `src/lib/env.ts` also gives the running app. One
batch run spent $4.69 of that $5 key and left the live site's Ask fallback with
$0.31. **Never point a batch job at `OPENROUTER_API_KEY`.**

## Operations

The four surfaces (public 3418, demo 3419, instructors 3420, mcp 3421) are
deployed by `local.zencub-rag-autodeploy`, which polls `origin/main` every five
minutes. Failures page over Telegram via `scripts/deploy/notify.sh`; a quiet log
means idle, not stopped.

Every surface is verified against the build sha after a deploy, and the
steady-state check covers all four, so a surface that dies between deploys
triggers a redeploy and pages if it will not come back. This matters most for
3421, the only surface nobody ever browses to.
