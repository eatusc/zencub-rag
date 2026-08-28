# Work Log - zencub-rag MCP server

> **How to log:** terse record of what we did and decided, one session per
> heading, newest at the bottom. One bullet per change; cite files, commits,
> migrations, and the evidence behind any claim. Past tense, skimmable.
> NOT error logs, stack traces, or debugging play-by-play.

## 2026-08-27 - Review, plan, and Phase 0 migration drafted

Reviewed the app end to end and queried the live database directly before
proposing anything. Created `mcp/` as the home for the server, its plan, and
this log.

### Confirmed the target database is TEST, not prod

- The two project refs are named explicitly in
  `../zencub/docs/gameplan-implementation-plan.md:55-56`, one marked Test
  (us-west-1) and one marked Prod (us-east-2). The literal refs are not repeated
  here: this repository is public.
- Every credential in `zencub-rag/.env.local` points at the Test project:
  `NEXT_PUBLIC_SUPABASE_URL`, `LANGGRAPH_DATABASE_URL` (as `postgres.<test-ref>`
  through the us-west-1 Supavisor pooler on 5432), and `RAG_TEST_PROJECT_REF`.
  All three agree.
- Grepped `.env.local` and `scripts/deploy/prod.env` for the prod ref: 0 hits in
  both. It appears nowhere in this repo.
- The MCP server will still assert the ref at startup rather than inherit it,
  so this cannot drift later.

### What the review found

- The database behind this app is not a RAG database. It is the whole ZenCub
  TEST database: **61 tables in `public`**, of which only 13 are `rag_*`. The
  rest covers user accounts, authentication, billing, and support, several of
  them carrying real rows rather than being empty. `LANGGRAPH_DATABASE_URL`
  connects as the owner with full read *and write* on all of it. That
  credential must never reach an MCP server.
- Retrieval libraries are framework-free. Checked every import in
  `ragPipeline`, `ragRetrieval`, `ragUtils`, `timestampRefinement`,
  `instructorComparison`, `answerProviders`: nothing from `next/*`. Only the
  `@/` tsconfig alias stands between them and a plain Node process, which is
  why `scripts/*.ts` all use relative imports.
- Measured corpus (not from docs): 14,274 chunks, 100% embedded, across 2,847
  videos; `rag_videos` holds 3,032, so ~185 have no transcript. 3,432
  techniques. 477 creators = 266 person / 206 channel / 5 publisher. 2,846
  attributions, all already at confidence >= 0.7. HNSW and GIN FTS indexes
  both present on `rag_transcript_chunks`.

### Decisions

- Scope the server to `rag_*` only, enforced by Postgres grants rather than by
  filtering SQL strings at runtime.
- stdio transport first for local Claude Code; `/api/mcp` over Streamable HTTP
  deferred to Phase 4.
- No answer-generation tool. The MCP client is already a model; return evidence
  and let it synthesise.
- Full rationale and the phased plan live in `PLAN.md`.

### Built

- `mcp/PLAN.md` - phased plan, locked decisions, measured corpus facts, open questions.
- `mcp/migrations/0001-rag-mcp-schema-and-reader-role.sql` - schema `rag_mcp`
  with 8 curated views, plus login role `zencub_mcp_reader` granted SELECT on
  that schema and nothing else. Encodes the two joins the app gets right and a
  naive query gets wrong: attributions key on the internal uuid while chunks and
  techniques key on the external text id, and only `coalesce(kind_override,
  kind) = 'person'` creators may be presented as instructors.
- `mcp/scripts/verify-reader-role.sh` - deterministic privilege matrix, plus a
  `--live` mode that connects as the role and fails if it can read any relation
  outside `rag_mcp` or create a table. Both the deny-check and the live probe
  read their targets from the catalogue, so the script names no application
  table and cannot go stale as the app adds one.

### Verified

Ran the full migration against TEST inside `BEGIN; ... ROLLBACK;`, so nothing
persisted. Results:

- All 8 views created cleanly. `v_corpus_stats` returned
  `3032 | 2847 | 14274 | 14274 | 3432 | 266 | 477 | 2846`, matching the direct
  table counts taken separately, and `corpus_synced_at = 2026-08-07 04:05:52+00`.
- Privilege matrix for the role, via `has_table_privilege` (works without
  membership, unlike `SET ROLE`): **t** for all four sampled `rag_mcp` views;
  **f** for `public.rag_transcript_chunks`, `public.rag_videos`,
  the raw `public.rag_*` tables, and every other relation sampled across
  `public` and `auth`, including the account, billing, and support tables.
- INSERT/UPDATE/DELETE all **f** on the views it can read.
- `CREATE` schema privilege **f** on `rag_mcp`, `public`, `auth`, `langgraph`,
  `storage`.

Two findings from the validation run worth carrying forward:

1. `SET ROLE zencub_mcp_reader` failed with "permission denied to set role".
   Expected on PG16+: a `CREATEROLE` role that creates a role gets ADMIN but not
   SET on the membership, and this connection is `postgres` with
   `rolsuper = f, rolcreaterole = t` on PostgreSQL 17.6. Verification therefore
   uses `has_table_privilege` rather than `SET ROLE`. Does not affect the
   migration; the role still works for a direct login.
2. The enumerated check found a relation the earlier hand-written list had
   missed, which is the argument for enumeration in one line. Supabase ships
   `pg_stat_statements` and `pg_stat_statements_info` in the `extensions` schema
   with SELECT granted to `PUBLIC` (`=r/postgres` in `relacl`), so every role in
   the database can read them, this one included. They expose normalised query
   text, constants replaced by placeholders, not row data. Revoking from
   `PUBLIC` is a database-wide change touching every role, so the script treats
   it as a named, explained exception and fails on anything else, rather than
   making that call silently. **Open decision for Eric:** revoke it from PUBLIC,
   or accept it. `dashboard_user` holds its own explicit grant, so a revoke
   would not break the Supabase dashboard.
3. `has_schema_privilege('zencub_mcp_reader','public','USAGE')` is **t** and
   stays that way. Postgres grants schema USAGE on `public` to `PUBLIC`, and
   revoking it would hit every role in the database including the app's. It
   confers name resolution only; every table SELECT in `public` is **f**, so no
   data is reachable through it. Documented in the verify script rather than
   worked around.

### Not done yet at the time of writing (both resolved later the same day)

- Migration is drafted and validated, **not applied**. The tracked file still
  carries `REPLACE_WITH_GENERATED_PASSWORD`, and always will: the real password
  is substituted into a temporary copy at apply time and lives only in
  `.env.local`.
- Open blocker to test first: whether the Supavisor pooler accepts a custom role
  as `zencub_mcp_reader.<project-ref>`. If not, the fallback is the project's
  direct host on 5432, which needs IPv6 or the IPv4 add-on.

### Housekeeping

Decided to keep the MCP server in `zencub-rag` rather than a new repo: Phase 2
needs `src/lib/ragRetrieval.ts` directly, and duplicating the RRF/rerank/
diversity math into a second repo would drift silently, since retrieval
regressions return worse clips rather than throwing. `mcp/migrations/` and
`docs/migrations/` also apply to the same database and need one ordering, and
Phase 4 lands inside the Next app regardless.

Consequence, caught before the first commit: this repository is **public**, and
the first draft of these files hardcoded both project refs. Scrubbed all five.
The expected ref now comes from `RAG_TEST_PROJECT_REF`, which is already the
app's own guard in `scripts/embed-rag-chunks.ts`, so there is one source of
truth rather than two that can disagree.

## 2026-08-27 - Supavisor probe, Phase 0 applied and verified

Settled the unknown blocking Phase 0, then applied it. Two throwaway probe roles
were created and dropped; `pg_roles` confirmed 0 remaining each time.

**The pooler accepts a custom role.** Connecting as `<role>.<project-ref>`
returned the expected `current_user` on both session (5432) and transaction
(6543) mode. No direct connection, no IPv4 add-on, no dashboard configuration.

**Correction to an earlier reading of the same probe.** The first probe showed
`default_transaction_read_only = off` and `statement_timeout = 2min`, and I took
that to mean `ALTER ROLE ... SET` does not survive the pooler. That was wrong,
and the applied role disproves it: `zencub_mcp_reader` reports
`on | 5s | rag_mcp` through the pooler, repeatably, on both ports.

The real mechanism, reproduced deliberately with a second probe role: settings
take effect only if they exist **before** the role's first pooled connection. A
role connected first, then altered, kept reporting `2min` across six retries over
a minute. The migration works because `CREATE ROLE` and the `ALTER ROLE ... SET`
lines are in one transaction, so the settings are in place before anything can
connect.

Practical consequence, now in the migration comment: treat these as
set-once-at-creation. Changing one later means recreating the role or waiting out
the pool, not assuming it applied. The server therefore also sets its own
timeout and wraps queries in `BEGIN TRANSACTION READ ONLY` -- not to compensate
for a broken mechanism, but so nothing tunable depends on a setting that is
awkward to change.

**Grants are unaffected and were confirmed live.** A probe role attempting
`CREATE TABLE public.probe_should_fail` through the pooler got
`ERROR: permission denied for schema public`.

### Phase 0 applied

Migration run against TEST, committed. Password generated with
`openssl rand -hex 32` (hex rather than base64 so the DSN needs no escaping),
written only to `.env.local`; a `replace_me` stub was added to `.env.example`.

`mcp/scripts/verify-reader-role.sh --live` is green:

- All 8 `rag_mcp` views readable.
- Readable relations outside `rag_mcp`: `public` 0/64, `auth` 0/23,
  `langgraph` 0/4, `storage` 0/8, `extensions` 2/2 (the known
  `pg_stat_statements` exception, still an open decision).
- INSERT/UPDATE/DELETE all f. `CREATE` f on every schema.
- Live as the role: `current_user = zencub_mcp_reader`, `read_only = on`,
  corpus stats returning `3032 | 2847 | 14274 | 14274 | 3432 | 266 | 477 | 2846`.
- Reading a non-corpus table in `public` and in `auth`, and attempting a write:
  all three denied.

Phase 0 is done. Phase 1 next.

## 2026-08-27 - Phase 1 built: seven tools, stdio, registered and green

The server is live and connected to Claude Code. `claude mcp list` shows
`zencub-rag ... Connected`.

### Built

- `mcp/src/db.ts` - env loader (an MCP server is launched with a near-empty
  environment, so it cannot rely on a shell), config with two startup
  assertions, and a `pg` pool that runs every statement inside
  `BEGIN TRANSACTION READ ONLY` with a `SET LOCAL statement_timeout`.
- `mcp/src/sqlGuard.ts` - shape checks for caller SQL. Blanks string literals,
  dollar-quoted blocks, and nested block comments before checking, so a keyword
  inside a literal neither trips the guard nor sneaks past it.
- `mcp/src/server.ts` - seven tools: `describe_schema`, `corpus_stats`,
  `query_sql`, `get_video`, `get_instructor`, `list_techniques`,
  `get_transcript_window`, `health`.
- `mcp/scripts/smoke-test.ts` - 37 assertions over real MCP against the real
  database.

### Decisions worth keeping

- **The guard is not the security boundary and says so in its own header.** The
  boundary is the grant plus the read-only transaction. The guard exists to
  return a usable error instead of a Postgres one. Writing it the other way
  round is how people end up trusting a regex.
- **Truncation is disclosed in every result.** A silently clipped result is how
  a model ends up reporting "there are 200 videos" when there are 3,032.
- **Row limit is applied as an outer `SELECT * FROM (...) LIMIT n`**, not by
  appending `LIMIT`, because the inner query may already carry its own LIMIT,
  ORDER BY, or UNION.
- **Duplicate column names are suffixed rather than collapsed.** pg's object row
  mode silently keeps only the last `id` in `select a.id, b.id`.
- **No answer-generation tool**, as planned. The client is already a model.
- Registered at **user scope**, not project. `claude mcp add --scope project`
  wrote an absolute path containing the username into `.mcp.json`, which would
  have been committed to a public repo and would not work on another machine.
  Removed it and the empty file it left behind.

### Verified

- `mcp/scripts/smoke-test.ts`: **37 passed, 0 failed**. Covers the handshake and
  tool list, health reporting `zencub_mcp_reader` with `read_only = on`, corpus
  counts, all eight views described with no embedding column exposed, row
  limiting and truncation disclosure, every tool returning real data, and eight
  rejection cases.
- Rejections proven, not assumed: leading DELETE/UPDATE/CREATE/SET, a
  multi-statement query, a data-modifying CTE (`with d as (delete ...)`), a
  write hidden behind a block comment, and a `UNION` reaching for a non-corpus
  table, which is refused by Postgres with `permission denied` rather than by
  the guard. A forbidden keyword inside a string literal is correctly allowed.
- `npm run typecheck` clean, `npx eslint mcp` clean, `npm test` 69 passed.
- `npm audit --omit=dev` reports 4 high findings in `sharp` and `postcss`, both
  reached through `next`, neither introduced by the MCP SDK. Pre-existing.

### Two corrections made during the build

1. Four smoke-test cases failed at first. The code was right and the test was
   wrong: a statement whose first word is `DELETE` trips the leader check before
   the keyword scan, so asserting on the keyword message was asserting the wrong
   thing. Assertions now match the correct behaviour, and the CTE case
   deliberately still asserts the keyword path because `WITH` is a legal leader.
2. Node's strip-only type stripping rejects TypeScript parameter properties
   (`constructor(private readonly config: X)`). Assigned the field explicitly.
   Worth remembering for anything else in this repo run via
   `--experimental-strip-types`.

### Next

Phase 2: semantic retrieval. First step is the `tsx` alias spike, since the app's
retrieval libraries are framework-free and only the `@/` path alias stands
between them and this process.

## 2026-08-28 - Phase 2 spikes settled, and the gate we nearly shipped was wrong

Two things resolved by measurement, both of which reversed a recommendation
made earlier the same day.

### The content gate: do not use `martial_arts_relevance`

Yesterday's finding stands on the facts and was wrong on the prescription. The
inconsistency is real: `pipeline.ts:1037-1044` stops technique extraction on a
`MartialArtsRelevanceError`, chunking and embedding have already run,
`rag-sync-prod-snapshot.ts` filters on neither column, and
`match_rag_transcript_chunks` is `WHERE embedding IS NOT NULL` with no join to
`rag_videos`. 2,912 chunks, 20.4% of the corpus, reach retrieval that way.

The error was proposing `martial_arts_relevance = 'no'` as the gate. That flag
answers "is there a technique to extract here", not "is this useful to a
practitioner". Reading the chunks rather than the titles showed the two
questions diverge on 1,021 of them:

| bucket | videos | chunks | verdict |
| --- | --- | --- | --- |
| event / stream coverage | 21 | 961 | exclude |
| coach AMA / fight analysis | 13 | 616 | keep |
| interview / discussion | 7 | 405 | keep |
| other, small clips | 243 | 930 | unread |

Event coverage is confirmed worthless: the chunks a keyword probe flagged as
instructional read "Boom. What's up everybody?" and "get subscribed... Portofly
chat's back". The Zahabi AMAs are the opposite and are why the flag is wrong:
"to alleviate sciatic pain... finding knots in your glutes and your hips", "I
teach you how to decompress your back while you're sitting in a chair". That is
training-longevity coaching, and it is in scope.

A title scan alone would not have caught this. It reported 7 false positives
totalling 8 chunks and looked clean. Reading the text found 128x more.

### Live evidence that the problem is not theoretical

Against the running app on 3418, `"heel hook defense"` returns **four of its top
five results from competition coverage**: Polaris 37 at #1, WNO Youth Grand Prix
#2, Team BJJ Stars vs Polaris #4, the ADCC -65kg supercut #5. Only #3, a kneebar
seminar, is instruction. `"knee cut"`, `"escaping side control"` and
`"armbar from guard"` are mostly clean, so the failure is query-dependent rather
than pervasive, but it is present in production today.

### Phase 2 transport: HTTP, decided on credentials

**Spike A (in-process) works and is disqualified.** No `tsx` required:
`mcp/scripts/alias-hook.mjs` is 35 lines of `module.registerHooks` mapping
`@/*` to `src/*` and supplying the extension bundler resolution omits. With it,
`node --experimental-strip-types` imports the whole retrieval core cleanly,
10/10 assertions in `mcp/scripts/spike-retrieval-import.ts`. The import graph is
`openai`, `@supabase/supabase-js` and `@/lib/*`, no `next/*` anywhere.

But `createServerSupabase()` builds its client from `SUPABASE_SERVICE_ROLE_KEY`,
so importing the core in-process puts that key in the MCP process: full read and
write on 61 tables, RLS bypassed. That is precisely what Phase 0 exists to
prevent. The spike answered the question it was asked and a better one it wasn't.

**Spike B (HTTP) chosen.** 272ms, 306ms and 516ms for 12 results across three
queries. Results already carry `video_url`, `video_title`, `channel_name`,
`platform`, `start_seconds` and a preformatted `citation`, so chaining and deep
links need no second call. The service-role key stays in the Next process, the
MCP server keeps only `zencub_mcp_reader`, and one retrieval path serves both
surfaces. Enrichment goes through the reader role: HTTP for ranking, `rag_mcp`
for corpus facts.

## 2026-08-28 - Phase 2 shipped: search_transcripts over HTTP

### Built

- `mcp/src/search.ts` - retrieval over the app's own endpoints, RRF fusion of
  `/api/rag/search` (text) and `/api/rag/vector-search` (semantic), plus
  deep-link construction with an explicit precision field.
- `search_transcripts(query, mode, limit, filter)` in `server.ts`.
- `health` now probes the app as well as the database. A health tool that only
  checked Postgres would report ok while retrieval was dead.
- `mcp/scripts/search-test.ts` - 20 assertions over real MCP. Kept separate from
  `smoke-test.ts` because it needs the app running and the SQL tools do not, so
  a failure is attributable.

### The filter is a parameter, not a decision

No available signal is correct alone, so the tool offers four and reports what
each removed. `none` reproduces the live site; `flagged` drops
status=failed/relevance=no; `instructional` drops videos with zero technique
cards; `strict` drops both.

A third gap surfaced while measuring: **three finance videos are in the corpus
with `martial_arts_relevance = NULL`** - "Is AI Taking Money & Attention Away
From Bitcoin?" (Pompliano, 46 chunks), "The One Signal That Matters for Gold and
Silver" (Kitco, 40), "Bitcoin: The Four Year Cycle Is Not Dead" (22). Status
`analyzed`, never classified, fully embedded, retrievable on the live site. The
relevance check did not merely mis-answer for these; it never ran.

Corpus by instructional signal: 20.4% flagged non-relevant, 23.5% kept with zero
technique cards, 56.1% carrying cards.

### Measured on real queries

`heel hook defense` at `filter=none` returns "2026 Polaris 37" at #1 and the WNO
Youth Grand Prix at #3. `flagged` removes Polaris. `strict` removes both.

Both filters have honest limits, recorded rather than smoothed over:

- `strict` still admits "Team BJJ Stars vs Team Polaris" because that match
  footage carries 2 technique cards.
- `strict` wrongly drops "7 Reasons Why Your Side Control Escapes Sucks"
  (Chewjitsu) and the Zahabi AMAs, which are instructional but produced no
  cards. It is the aggressive setting, not the correct one.

`flagged` is the safe default and is what the tool ships with.

### Verified

`mcp/scripts/search-test.ts` 20 passed 0 failed; `smoke-test.ts` still 37 passed
0 failed; `npm run typecheck` clean; `npx eslint mcp` clean.

## 2026-08-28 - Phase 3 filter validation, the NULL relevance population, bucket 4 read

Confirmed `search_transcripts` live from a fresh session, then worked the
outstanding queue. Three items closed, one deliberately stopped short.

### search_transcripts verified from a real session

`health` green on both halves: database 186ms as `zencub_mcp_reader` with
`read_only = on`, app 200 in 1,232ms. `heel hook defense` at `filter=none` and
`filter=flagged` retrieved the same 37 candidates; `flagged` removed exactly one,
"2026 Polaris 37", whose text is "Ladies and gentlemen, your winner by Chapo due
to a heel hook". The right hit to lose.

It is also the demonstration that `flagged` is not sufficient: the WNO Youth
Grand Prix, "Team BJJ Stars vs Team Polaris" and the ADCC -65kg supercut all
survive it, all pure event commentary, the last two because they carry technique
cards.

### The three finance videos: the check never ran, and they are not alone

Root cause is one deliberate flag. `src/app/api/user/import/route.ts:258` passes
`skipRelevanceCheck: true` for every user submission ("Preflight is the
commitment gate... we charge regardless of the result"), and
`src/lib/pipeline.ts:297` guards the only write with
`if (!skipRelevanceCheck && !transcriptOnly)`. So the column is never written for
user submissions. All three finance videos are `source = user_submitted`.

Scale, which was the part worth knowing: **150 videos / 718 chunks have NULL
`martial_arts_relevance`**, 129 of them user submissions spanning 2026-04-16 to
2026-08-06, plus 21 `batch_import` rows all created 04-16 to 04-20 before the
check existed. Separately, **268 videos / 907 chunks are `uncertain`**, a value
`src/lib/types.ts:123` does not admit exists.

`checkMartialArtsRelevance` (`src/lib/ai/quality.ts:108-131`) reads only title
and channel, never the transcript, and returns `uncertain` both on weak metadata
and on a thrown LLM call.

Verified the consequence live rather than reasoning about it:
`search_transcripts("bitcoin four year cycle", filter: "flagged")` returns three
chunks of Benjamin Cowen on Bitcoin, `removed_by_filter` empty, with
`instructor_name: "Benjamin"`. `flagged` tests `status=failed AND relevance=no`;
NULL and `uncertain` pass straight through.

### Bucket 4 read in full: 243 videos, 930 chunks

All three size bands, transcript text rather than titles. "Other, mostly small
clips" was wrong. It is dominated by instructional channels -- Bernardo Faria
25/55, Chewjitsu 10/47, ART OF JIU JITSU 19/42, Keenan 9/38, Matt Arroyo 24/32 --
with FloGrappling the largest single block at 32/199 and genuinely event
coverage.

Excluding it wholesale would have destroyed straight technique instruction
(Brian Glick's "Beginners Guide To Inside Camping", six chunks of half-guard
teaching; Knight Jiu-Jitsu's "Handgun Choke Guard Pass"), physical preparation
(two Scott Georgeaklis foam-roller videos, 13 chunks), and a large body of
training advice.

**It also produced a class the plan did not have.** Titles promise a technique
and the transcript is song lyrics over silent footage: "Keenan Cornelius passing
lapel guards" is five chunks of "♪♪"; Cobrinha's "Guard Passing Drills" is "I
love you. I love you."; "Next level Guard passing" is "The thing about the
potato."; two "Lachy lock" videos are rap verses; a FloGrappling highlight is the
word "Heat." for seven chunks.

Measured whether that class is cheaply detectable, and it is not. Bracket-marker
ratio plus non-Latin script flag **231 chunks in the whole corpus**; repetition
and near-emptiness add ~108 across the flagged set. Song lyrics look exactly like
speech to text statistics. It needs a model, which makes it a `content_kind`
value rather than a filter.

### Phase 3: filter validation, and a worse bug found while fixing it

The known failure was `list_techniques(gi_nogi: "nogi")` returning 0 rows
cleanly. The one found while fixing it is worse: filters were `ILIKE '%value%'`,
and `'no_gi' ILIKE '%gi%'` is true, so **`gi_nogi: "gi"` returned no_gi cards**.
Not an empty set, the opposite of the question, in well-formed rows.

Built `mcp/src/enums.ts`. `gi_nogi`, `type` and `difficulty` now match exactly
against the live distinct values after canonicalising case and punctuation;
`position` stays a substring match because its columns are hierarchical, but
reports which values it matched. Unknown values and unknown instructor slugs are
refused with the real values named.

Decisions worth keeping:

- **Canonicalisation is checked for injectivity at load**, and the field falls
  back to exact spelling if two stored values ever collapse to one key. A
  normaliser that silently merges values would be the same bug wearing a hat.
- **A cache miss forces one reload before refusing.** A stale vocabulary
  rejecting a legitimate new value is the same confident-wrong-answer class
  pointing the other way.
- **An unknown instructor slug says so.** "No instructor with slug X" and "this
  instructor has no techniques" are different claims and the tool used to make
  the wrong one.
- **Every call echoes `filters_applied`**, so a filter resolving to something
  unexpected is visible rather than invisible.

Corrected a number this plan carried: the true `no_gi` answer is **234 cards over
141 videos**, not 28. 28 is not reproducible from `gi_nogi` alone; `no_gi` plus
`advanced` is 27, the nearest reading.

### content_kind: drafted, graded, deliberately not run

`mcp/migrations/0002-content-kind.sql` adds `content_kind` plus confidence, model
and timestamp to `rag_videos`, a CHECK over the six values, a partial index, and
the columns on `rag_mcp.v_videos`. Validated against TEST inside
`BEGIN; ... ROLLBACK;`, clean. Nullable with no default, because NULL means "not
classified" and the 150 NULL relevance rows are the standing proof that
collapsing those meanings hides a population. Not `DROP VIEW ... CASCADE`:
`pg_depend` shows 0 dependents today, so CASCADE buys nothing now and could
silently drop one added later.

`mcp/scripts/classify-content-kind.ts` samples transcript across the whole video
rather than the head, writes through the owner DSN and never the reader role,
commits per video so a run that dies at 80% keeps the 80%, and treats an
out-of-enum model answer as a failure rather than coercing it to a neighbour.

**Graded against 28 hand-labelled videos** (`mcp/scripts/gold-content-kind.ts`,
every label set by reading the transcript, not the title).
`anthropic/claude-haiku-4.5` scores **24/28**, above the 85% bar the script exits
non-zero below. **5/5 on `no_content`**, and it recovers every wrongly-flagged
instructional video including the inside-camping and foam-roller cases.

**Stopped there on purpose.** All four misses are on the
`event_coverage` / `interview` boundary, which is precisely the boundary that
decides exclusion, and two push a keeper into the excluded class: Zahabi's
round-by-round Khamzat analysis and the Nathan Haddad ADCC documentary both came
back `event_coverage`. The prompt is at fault, not the model: it files "MMA fight
analysis" under `interview` and "competition commentary" under `event_coverage`,
and a round-by-round recap of one fight is both. Sharpen it, re-run `--eval`,
classify after that.

One bug found in the script by running it rather than reading it: the first
`--eval` returned 28 OpenRouter 401s because `API_KEY` is a module-level const
evaluated before `loadEnv()`, so only shell-exported variables reached it and
`.env.local` read as empty. Worth remembering for anything else in `mcp/scripts`.
The failure path itself behaved correctly, which is how it was legible: per-row
errors, counted, non-fatal, non-zero exit, and the gold bar refused the run.

### Verified

- `mcp/scripts/smoke-test.ts`: **56 passed, 0 failed** (37 prior + 19 new).
- `mcp/scripts/search-test.ts`: **20 passed, 0 failed**.
- `npm run typecheck` clean; `npx eslint mcp` clean.
- Migration 0002 applied and rolled back against TEST with `ON_ERROR_STOP=1`:
  `ALTER TABLE`, `CREATE INDEX`, `DROP VIEW`, `CREATE VIEW`, `GRANT`, then
  `content_kind` readable through `rag_mcp.v_videos`, 3,032 videos / 0
  classified, `ROLLBACK`.

### Still open

- `search_transcripts` does not yet log to `rag_search_logs` under its own
  action, so MCP retrieval quality is still not measurable next to the site's.
- Phase 3 failure reporting is still undecided: this server can report success
  and cannot report that it broke.

## 2026-08-28 - Transcript stitching fixed; the retrieval path is not what the plan claimed

Ran ten-odd real queries through MCP to see what the tool actually returns.
Two defects fell out, one small and one structural.

### get_transcript_window repeated a sentence at every boundary

Chunks overlap deliberately, measured at 6.68s / 7.96s / 7.60s between indices
5-8 of one Zahabi AMA, and the tool joined their text with a space. Every
multi-chunk window therefore duplicated a sentence:

> "...progressively getting better and if it's not stop what you're doing.
> progressively getting better and if it's not stop what you're doing."

Same class as the others: well formed, plausible, wrong. A model quoting it
doubles a sentence; a model weighing emphasis sees a point made twice.

Fixed in `mcp/src/transcript.ts`. Detection is on text rather than timestamps,
because mapping seconds to character offsets inside a chunk is a guess while the
overlapping text is byte-identical -- both chunks render from the same segment
list. Longest match first, `minOverlap` 16 characters so a coincidental "and I"
cannot trigger a trim, and any boundary it fails to resolve is counted and
disclosed in the response rather than passing silently.

One bug of my own on the way: trimming leading whitespace off the remainder
glued "...choke" to "and then more". The separator is already inside the
remainder, because the matched span is a literal prefix of the next chunk.
Caught by unit tests before it reached MCP.

Four assertions added to `smoke-test.ts`, including that the known duplicated
sentence now appears exactly once. **60 passed, 0 failed.**

### search_transcripts is not calling the app's retrieval pipeline

Checked because search quality looked poor on technique queries. Semantic
retrieval **is** running -- `/api/rag/vector-search` returns real cosine
similarities, 0.53-0.61 on the queries probed -- so the earlier absence of a
degradation warning was accurate. The fault is elsewhere, in two layers.

**First: the Phase 2 record was wrong.** It states that the HTTP choice means
"both surfaces share exactly one retrieval path so they cannot diverge". That
was never verified and is false. `/api/rag/search` is FTS only
(`search_rag_transcript_chunks`); `/api/rag/vector-search` is vector only. The
hybrid pipeline -- `buildCandidates`, `rerankCandidates`, `enrichCandidates` --
lives in `ragPipeline.ts` and is reached only by `/api/rag/ask`, which always
generates an answer and therefore cannot serve this tool. The credential
argument for choosing HTTP still holds; the no-divergence argument does not.
Corrected in PLAN.md rather than quietly dropped.

**Second: the fusion is a zipper, not a blend.** `fuse()` is plain RRF at k=60
over two single-mode lists. When both return 10 results with no overlap, rank
*i* in either list scores identically, JavaScript's sort is stable, and the text
list is passed first -- so text wins every tie. Measured across eight queries the
top-8 source pattern is exactly `text,vec,text,vec,text,vec,text,vec` whenever
both lists are full. The precision of the alternation is the proof: it is a
tie-breaking artefact, not a ranking.

This explains the symptom exactly. "heel hook defense" gives FTS ten
confident-looking matches because the literal phrase is all over match
commentary, and the zipper hands them slots 1, 3, 5 and 7 -- which is why
"2026 Polaris 37" outranked the vector list's own top hit, an instructional
video. "how do I stop gassing out during rolls" returns **2** FTS hits against
10 vector hits, semantic dominates by default, and the answers are good. The
tool is strongest where keyword search fails and weakest where keyword search
returns plausible junk.

Also absent, all of it in `ragPipeline.ts`: the `metadataResults` path that
searches technique cards first and maps them back onto chunks, the rerank, and
`capPerVideo` applied across modes rather than within each route.

### MCP traffic is contaminating site analytics now, not later

The unchecked Phase 2 logging item is worse than missing. Both routes call
`logSearch` themselves, so every `search_transcripts` call already writes two
rows tagged `action=keyword` and `action=semantic`, indistinguishable from a
person on search.zencub.com. **119 rows in three hours**, every one a test query
from this session. Verified by reading them back: "knee cut pass", "why do I keep
getting my guard passed", "escaping bottom side control".

### Verified

`smoke-test.ts` 60 passed 0 failed; `search-test.ts` 20 passed 0 failed;
`npm run typecheck` clean; `npx eslint mcp` clean.

## 2026-08-28 - A fourth deployment, so MCP retrieval uses the app's real pipeline

Replaced the MCP server's own fusion with the app's retrieval, without changing
what either public site serves. The blast-radius question was asked first and
answered from the code, which changed the design.

### The proposed fix would not have worked

The plan was a `retrieve_only` flag on `/api/rag/ask`. It cannot work:
`consumeDailyAskBudget()` runs in `src/middleware.ts` keyed on
`pathname === "/api/rag/ask"`, **before the handler reads the body**, so no
request flag can opt out of it. Every MCP retrieval would have spent one of
search.zencub.com's 2,000 daily Ask allocations, and on exhaustion real visitors
see "Ask AI has hit its daily limit". The ~60 test searches run earlier in this
session would have taken 60 of them.

Also ruled out: exposing the route on the public surface behind a loopback
check. `clientIp()` reads `cf-connecting-ip`, `x-forwarded-for` and
`x-real-ip` and never the socket, so it is caller-controlled and cannot gate
anything.

### Built: APP_MODE=mcp, loopback only

- `src/lib/appMode.ts` - fourth mode with `MCP_API_ROUTES` = health plus
  `/api/rag/retrieve`, and nothing else.
- `src/middleware.ts` - `mcpMiddleware`: 404s everything off the allowlist
  including every page, and meters retrieval as `search`, never `ask`.
- `src/app/api/rag/retrieve/route.ts` - calls `buildCandidates`,
  `rerankCandidates` and `refineResultTimestamps`, stops before
  `generateAnswer`.
- `scripts/deploy/{build,serve,deploy}.sh` and a launchd plist for port 3421,
  with no Cloudflare Tunnel in front of it.
- `mcp/src/search.ts` - calls the new route; `fuse()` **deleted**.

**`ragPipeline.ts` was not touched, deliberately.** instructors.zencub.com
reaches `buildCandidates` and `metadataResults` through
`instructorCompareGraph` as a library import, so a change there would land in
the comparison workflow. The route layer was the only safe place.

### Blast radius, established before writing code and asserted after

- **instructors.zencub.com: unaffected.** `instructorsMiddleware` 404s
  everything outside `INSTRUCTORS_API_ROUTES`, which the new route is not in.
- **search.zencub.com: unaffected.** The route is not in `PUBLIC_API_ROUTES`.
  Deliberate: retrieval costs an embedding plus a rerank per call, and putting
  that on a tunnelled host would be an uncapped spend path.
- Seven new assertions in `tests/deploymentGating.test.ts` hold both directions
  -- the route is absent from both public surfaces, and neither lost a route it
  had. **All 69 pre-existing tests still pass**, which is the actual evidence.
- Verified live on the running surfaces after the change: 3418 health 200,
  3420 health 200, 3419 401 (demo PIN, correct).

### A near miss worth recording

Adding `local.zencub-rag-mcp` to `deploy.sh`'s restart list would have broken
deploys. The script runs `set -euo pipefail` and the job is not installed, so
`launchctl kickstart` on a missing label returns non-zero and would have aborted
the deploy **after** `build.sh` had rewritten every bundle -- leaving all three
live surfaces on a freshly built directory they had never restarted into, which
is the precise failure that file's header says it exists to prevent.

`restart_surface()` now warns loudly and continues for a job that is not
installed, while a job that *is* installed and fails to restart remains a hard
failure. Silence is not the same signal as success in either direction.

### Search logs are separated now

`mcp/migrations/0003-search-log-mcp-action.sql` widens the CHECK on
`rag_search_logs.action` to admit `mcp`; applied to TEST. Widening a CHECK
cannot reject an existing row, so nothing was backfilled. Verified by reading
the table back: 23 rows tagged `action=mcp` (hybrid 14, vector 5, text 4), and
the mislabelled `keyword`/`semantic` rows stop at the cutover. Human traffic is
now `action <> 'mcp'`. Rows already written as site traffic are not corrected;
they are indistinguishable from it by construction.

Also fixed: `health` probed `/api/rag/search?q=health`, which ran a real search
and wrote a log row on every health check. It now probes `/api/health`.

### What this fixed, and what it did not

`heel hook defense` now returns the Leduc seminar, Volkanovski and Craig Jones
on the back escape, and Eddie Cummings on inside sankaku in slots 2-4, none of
which the zipper ever surfaced, and the response reports `retrieval=hybrid`,
`reranked=true`.

**"2026 Polaris 37" is still #1.** The app's own rerank does not solve event
coverage. Only `content_kind` does, which leaves Phase 5 Tier 1 exactly where it
was rather than partly addressed.

One more gap found while reading: **`metadataResults` is never called by
`buildCandidates`.** Only `instructorCompareGraph` and `retrievalSubgraph` use
it. So the technique-card path is missing from `/api/rag/ask` too, not just from
MCP, and the Tier 2 claim that cards steer retrieval is true of the LangGraph
paths only. Recorded in PLAN.md, not fixed.

### Verified

`npm test` 76 passed (69 prior + 7 new); `smoke-test.ts` 60 passed 0 failed;
`search-test.ts` 27 passed 0 failed (20 prior + 7 new); `npm run typecheck`
clean; `npx eslint` clean on both `mcp` and the touched app files. Migration
0003 applied; 0002 still drafted and unapplied.

## 2026-08-28 - Autodeploy could not report failure; merged to main and deployed

Session opened by confirming the build was the new one, since the previous
session's server predated the fixes. All three checks pass against the running
server: `list_techniques(gi_nogi: "nogi")` canonicalises to `no_gi` and returns
200 rows capped out of 234; `gi_nogi: "kimono"` is refused naming
`both (2524), gi (630), no_gi (234)`; `search_transcripts` reports
`retrieval_mode: "hybrid"`, `reranked: true`.

### The alerting path named in the plan did not exist

`autodeploy.sh` had been failing every 5 minutes since 14:48 (checkout on
`mcp-server`, `deploy.sh` refuses any branch but main) and reached nobody.
Correctly, it failed safe: the branch guard runs before anything is touched, and
`/api/health` on 3418 confirmed the servers were already on `a4dcfc3` which was
`origin/main`, so nothing was actually pending. The failure was the silence, not
the deploy.

**The first fix proposed was wrong, and Eric caught it.** The plan was to reuse
`amzdash/scripts/notify-telegram.sh`, which sources `~/.hermes/.env`. Every
`TELEGRAM_*` line in that file is **commented out**; sourcing it yields
`TELEGRAM_BOT_TOKEN=[UNSET]` and `TELEGRAM_HOME_CHANNEL=[UNSET]`, so the script
hits its own guard and sends nothing. The check that "verified" the credentials
was `grep -c TELEGRAM_BOT_TOKEN`, which returned 4 by counting commented lines.
A cheap check producing a confident wrong reading, which is the same failure
class this project keeps finding in the tools themselves.

**Consequence outside this repo, recorded not fixed:**
`amzdash/scripts/daily-pull.sh:117,140` still calls that notifier, including for
"pipeline failed twice". That alerting path is dead today.

The live outbound path is `~/code/cladia/.env` with `CLADIA_BOT_TOKEN` and
`CLADIA_ALLOWED_USERS`, both uncommented, which is what
`sys_docs/scripts/jobs_audit.py:304` sends through and what the standing rule
means by Cladia's bot.

### Built

- `scripts/deploy/notify.sh` - curl-only page. No node, no python, no model, no
  dependency on the app or database, so the alerting path shares no failure mode
  with the build it reports on. Reads the two keys with `sed` rather than
  sourcing, because sourcing an unknown file executes it and `~/.hermes/.env`
  already errors on a stray Chrome path. Never echoes the token, including on
  error paths: this repo is public.
- `scripts/deploy/autodeploy.sh` - pages on failure and on recovery, carrying
  the last 12 lines of the deploy's own output so the page says why. Throttled
  to one page per failure then at most every 6 hours, with the last-paged clock
  deliberately *not* reset by repeat failures. A page that fails to send is not
  recorded as sent, so the next run retries rather than falling into the quiet
  window on an alert nobody saw. Exiting 0 on a failed deploy is guarded.
- `scripts/deploy/test-alerting.sh` - 15 assertions over the state machine in a
  throwaway git repo with `deploy.sh` and `notify.sh` stubbed. Sends nothing.

**Proven, not assumed:** one live test page sent, HTTP 200, and Eric confirmed
receiving it.

### Merged to main and deployed, on Eric's call

Merged `mcp-server` into `main` as a fast-forward (5 commits, `a4dcfc3` ->
`8e2644b`) and pushed. Scanned the outgoing diff for key-shaped strings and
project refs first, since the repo is public: every hit was a placeholder
(`YOUR_PROJECT_REF`, `replace_me`, `REPLACE_WITH_GENERATED_PASSWORD`) or an env
var name in prose.

Deploy driven by kickstarting the launchd job rather than running `deploy.sh` by
hand, so the new `autodeploy.sh` was exercised in situ. `deploy ok, now on
8e2644b`.

### Verified live after the deploy, rather than from the deploy log

- public 3418, instructors 3420, mcp 3421 all `health=200` on `8e2644b`; demo
  3419 returns 401, which is the PIN gate and correct.
- **The route gating holds after a real deploy**, which is the constraint that
  mattered: `POST /api/rag/retrieve` returns **404 on 3418 and 3420**, 200 on
  3421 only.
- `autodeploy.state` reads `ok`, so the next failure pages immediately.
- The `.next-mcp` stamp caveat from last session is resolved: 3421 now reports
  `8e2644b` rather than trailing at `f816574`.

### Gates

`npm test` 76 passed; `smoke-test.ts` 60 passed 0 failed; `search-test.ts` 27
passed 0 failed, re-run after the restart; `test-alerting.sh` 15 passed 0
failed; `npm run typecheck` clean; `npx eslint mcp src tests` clean.

### Still open

Phase 3 failure reporting is now solved for *autodeploy*, not for the MCP server
itself. That server still reports success and cannot say it broke.

## 2026-08-28 - content_kind classified and gated; the card path measured and rejected

### The corpus is classified

Two passes, on Eric's call, after the first single-model attempt was stopped.

**Pass 1, local Qwen (`qwen3.6:35b-mlx`), free, 62 minutes: 2,844 of 2,845.**
Ollama's OpenAI-compatible `/v1` endpoint cannot be used for a reasoning model:
with `max_tokens` 200 it spends all 200 on reasoning and returns
`finish_reason: length`, `content: ""`, with the thinking in a separate
`reasoning` field, so all 30 gold rows failed to parse. `enable_thinking` via
`chat_template_kwargs` on `/v1` is ignored. The native `/api/chat` endpoint
honours `think: false` and returns clean JSON in ~0.6s.

**Pass 2, Haiku, $1.14, over only the 406 videos pass 1 wanted to exclude: 381
agreed, 25 overturned.** The rescues include "Most Underrated Armbar in Jiu
Jitsu", a side control escape, solo torreando drills and another Zahabi fight
discussion. **6% of Qwen's exclusions were wrong**, which is the two-pass paying
for itself rather than a precaution.

The design's justification is measurable rather than rhetorical: on the 35-item
gold set *each model alone* scores 34/35 with one false exclude, and they fail
on **different videos** -- Qwen on Zahabi's post-fight analysis, Haiku on his
pre-fight one. Because the verifier only ever sees what pass 1 wants to exclude,
Qwen's error is caught and Haiku's is unreachable.

**Verified end to end against the database, not argued from two eval runs:** the
35 gold videos come back **35/35 on the keep/exclude gate, 0 false excludes**.
Exact labels 33/35, both disagreements inside the kept set where they cannot
reach a retrieval decision.

### The seventh class, found by auditing rather than reasoning

`off_topic` was added after reading the first run's output. The six values in
0002 came from reading the *flagged* set, which was all grappling, so a Tesla
review, a Bangkok travel vlog, streetball and the finance videos had nowhere to
go and the model filed them as `no_content` -- wrong by that class's own
definition, since every one is fluent English.

That wastebasket had already started swallowing keepers: "Technical Stand-up
sweep" is garbled ASR of a real lesson ("I look to the shoulder feeling lif the
sweep from the leg") and was also `no_content`. The prompt now states that badly
transcribed speech is still speech.

Migration 0004 widens the CHECK to seven values and adds
`content_kind_verified_model` / `_at`, so "checked and agreed" is
distinguishable from "never checked".

### The gate is live

`heel hook defense`, on the running pipeline:

| filter | #1 |
| --- | --- |
| `none` | `[event_coverage]` 2026 Polaris 37 |
| `curated` | `[instruction]` Part 2 - Leduc BJJ Seminar |

`kimura from side control`, `escaping side control` and `how do I stop gassing
out during rolls` are **unchanged**, including "7 Reasons Why Your Side Control
Escapes Sucks", which the old `strict` filter wrongly dropped. The gate removes
what it should and nothing else.

Two defects found by running it:

- **The gate shrank the page.** Filtering happens after retrieval, so `curated`
  at limit 5 returned 3. A comment claimed over-fetching "no longer widens the
  pool"; measured, that is false (limit 5 returns 5 rows, limit 15 returns 12),
  so the route now over-fetches when a filter is active.
- `retrieved` vs `returned` became misleading once they legitimately differ, so
  the response reports `requested_from_retrieval`.

Default flipped `flagged` -> `curated` in the same change that verified
coverage, as the previous commit's comment promised.

### The technique-card path: wired, measured, rejected

PLAN.md Tier 2 recorded `metadataResults` never being called by
`buildCandidates` as a defect, on the claim that card quality "steers which
chunks retrieval returns". Wired into `/api/rag/retrieve` and measured, **the
claim does not hold**:

| query | effect of turning cards on |
| --- | --- |
| escaping side control | pushes the Danaher side control escape off #1 entirely; puts an untitled "Instagram Reel" at #4 |
| heel hook defense | displaces Eddie Cummings on inside sankaku with WNO event footage |
| berimbolo | no effect |
| half guard knee shield | neutral shuffle of slots 4 and 5 |

Ships behind `include_metadata: true`, **off by default**. Reserved slots are
displacement: every card hit costs a retrieval hit the rerank had already ranked
above it. Kept rather than reverted so the measurement is readable.

Two method notes worth more than the feature:

- **Appending would have been a silent no-op.** `rerankCandidates` takes
  `candidates.slice(0, RERANK_POOL)` and RERANK_POOL is 12, so adding card hits
  to a list already holding 12 drops every one before the rerank sees them.
- **The first A/B was wrong and looked great.** The first request after a
  restart returns a different order, so the OFF arm was reading a cold server.
  An OFF-twice stability control reversed the conclusion. Retrieval is otherwise
  deterministic: three identical calls give identical results.

`ragPipeline.ts` was not modified, as required.

### Cost and credentials

The first run 402'd at 1,663 videos. Two separate causes, both fixed:

- No `max_tokens` was set, so OpenRouter defaulted to the model's 64,000-token
  output ceiling and applied its affordability pre-check against that number.
  The reply is ~60 tokens. Now capped at 200.
- **The classifier was using `OPENROUTER_API_KEY`, which `src/lib/env.ts:49`
  also gives the running app.** A batch job spent $4.69 of a $5 key limit and
  left the live site's Ask fallback with $0.31. The classifier now takes
  `CONTENT_KIND_API_KEY`, a separate key, and `.env.example` records why.

Also: a 402 was treated as a bad row rather than a condition of the run, so it
retried the remaining 1,182 videos and buried the one useful fact under 1,182
copies of it. 402 and 401 now stop the loop at the first occurrence.

And the classification path had **never executed**: the non-eval query passed an
unused `$1`, which Postgres cannot type, so it failed before a single model
call. Every prior run was `--eval`, which takes the other branch.

### Verified

`npm test` 76; `smoke-test.ts` 60; `search-test.ts` 36 (27 -> 32 -> 36);
`test-alerting.sh` 25; `npm run typecheck` clean; `npx eslint mcp src tests`
clean. Migrations 0002 and 0004 applied to TEST, each validated inside
`BEGIN; ... ROLLBACK;` first.

## 2026-08-28 - The keep direction measured; a dead mcp surface can now page

### Confirmed the running build before anything else

Three checks against the live server, since the previous session's MCP process
predated the `content_kind` work:

- `search_transcripts("heel hook defense")` reports `filter: "curated"`, drops 4
  `event_coverage` chunks, and returns Leduc / Volkanovski+Craig Jones / Eddie
  Cummings with `content_kind` on every hit. No "2026 Polaris 37".
- The same query at `filter: "none"` puts "2026 Polaris 37" at #1, tagged
  `event_coverage`, over commentary reading "your winner by Chapo due to a heel
  hook".
- `list_techniques(gi_nogi: "kimono")` refuses, naming `both (2524)`,
  `gi (630)`, `no_gi (234)`.

### The unchecked direction, measured rather than argued

`--verify-excludes` only ever re-reads what pass 1 wants to drop, so a wrong
KEEP was unmeasured by construction: **2,439 of the 2,464 kept videos rested on
Qwen alone**. Added `--audit-keeps [--sample N] [--seed S] [--kinds a,b]`, which
draws a reproducible sample (`ORDER BY md5(video_id || seed)`), asks Haiku, and
**writes nothing**.

Writing nothing is the design, not caution. On the gold set Haiku alone scores
34/35 and **its own single error is a false exclude**, so overwriting a keep on
its disagreement would manufacture exactly the error the two-pass design exists
to prevent - unattended, across the whole kept corpus.

**Uniform stratum, 150 of 2,439:** 4 disputed, 2.7%, 95% Wilson upper bound
6.7%. Read all four: 1 clear false keep, 1 defensible, and **2 Haiku errors** -
it called a narrated D'Arce ("I lock it, right? And I pull this over. Now, I
start cranking") `no_content`, and called an argument about street fighting
`off_topic` when its own prompt reserves that for content not about fighting at
all.

**The real false keeps have a deterministic signature.** Strip the
`bjjfanatics.com` tagline, `[music]`/`[applause]` and `>>` from a whole
transcript: 97 videos have under 25 characters left, **90 already `no_content`,
exactly 6 kept**. All six read; their complete transcripts are "Let's go!", a
music-note outro marker, "[Music] you", "[music] >> Learn from the best on
bjjfanatics.com.", "Thanks for watching!" and "It is time." Every one is
`no_content` by that class's own definition and retrievable today. They carry
enormous titles holding full technique descriptions, which is what the prompt
warns about and the model followed anyway.

So the title-pattern estimate this was meant to check - the weakest claim of the
previous session - **was roughly right**: it said 5 videos / 7 chunks, an
independent deterministic rule says 6 videos / 6 chunks, **0.05% of the 11,459
kept chunks**. The $6.85 full second pass is not justified.

**The cause was the verification pass, not pass 1.** Five of the six carried
Haiku as their labelling model, so they were among the **25 exclusions Haiku
"rescued" from Qwen**. Qwen had them right; the second opinion overturned
correct exclusions and put boilerplate back into the corpus. That is **5 of 25
rescues, 20%**, against 6 of 2,464 kept videos, 0.24%, across the kept set. The
two-pass still paid for itself - the other 20 rescues include real instruction -
but the previous session measured only how often Qwen's exclusions were wrong,
never how often a rescue was. That direction had no gold coverage and no
measurement until now, and it is where the false keeps actually came from.

**`interview` stratum, all 98 unverified:** 11 disputed, 11.2%, over the 5% bar
set before the run - and the bar firing is the most useful thing the audit
produced, because the conclusion it invites is wrong. Seven of eleven are
`interview -> event_coverage`, 198 of the 203 disputed chunks, on the one
boundary the gold set already records Haiku failing. The largest, `cj0kftppPvM`
(84 chunks), **is in the gold set as a hand-labelled keep** whose note reads
"Came back event_coverage, which would have deleted it." The second, `u5payaNB37E`
(78 chunks), was read here: Zahabi in his own voice on striking mechanics, which
the prompt's own test makes `interview` "EVEN IF he goes round by round". The
remaining four are 1-2 chunk banter clips.

The over-bar message was rewritten afterwards: it used to assert "the kept set
needs the full second pass", which this run disproves. It now says to read the
disputed rows and warns that a high rate in a stratum full of that boundary may
be measuring the verifier rather than the corpus.

### A dead mcp surface could not reach anybody

Two defects, both found by reading the deploy log rather than reasoning about it:

- **`deploy.sh` restarted 3421 and never verified it.** It kickstarts four
  surfaces then checks 3418, 3420 and 3419. The last deploy's log lists public,
  instructors and demo and stops. A build breaking only `APP_MODE=mcp` was a
  successful deploy.
- **`autodeploy.sh`'s steady-state check read 3418 alone.** launchd restarts a
  crashing surface forever (`KeepAlive`, `ThrottleInterval 15`) and says
  nothing, so 3421 could crash-loop while autodeploy wrote `ok` every 5 minutes.

Both now cover every surface. A surface behind the expected sha triggers a
redeploy; if it still will not come up, `deploy.sh`'s new per-surface check
fails and the existing `mark_fail` pages on the 6-hour throttle. No new job -
the alerting path that already works was given the input it was missing.

**A third defect appeared while testing the fix**, and is the most instructive:
the first version rendered an unreachable surface as an **empty string**, so the
page would have read as though that surface simply went unmentioned. A silent
failure inside the silent-failure alarm. Fields now default to the literal word
`unreachable`, asserted.

### Verified

`npm test` 76; `smoke-test.ts` 60; `search-test.ts` 36; `test-alerting.sh`
**25 -> 35**; `npm run typecheck` clean; `npx eslint mcp src tests` clean.
`test-alerting.sh` now stubs `curl` on PATH, so it keeps its promise to touch no
real server, and its `pages()` helper is fixed - `grep -c` prints `0` and exits
non-zero on an empty file, so every count read as `0\n0`.

### Fixed, both the rows and the cause

- `mcp/migrations/0005-boilerplate-only-videos.sql`, **applied to TEST**.
  Set-based and stated as the rule rather than as six ids, so it cannot hit a
  row that does not meet it and running it twice is a no-op - verified,
  `UPDATE 6` then `UPDATE 0`. It can only move a video INTO `no_content`, never
  return one to the corpus. Validated inside `BEGIN; ... ROLLBACK;` first, which
  confirmed the six and left them untouched. The six prior labels are recorded
  in the file; that is what makes it reversible.
- `classify-content-kind.ts` now decides this class **before any model call**.
  Under 25 characters of residual speech across the whole transcript, after
  stripping taglines, `[music]`/`[applause]` markers, `>>` and music notes, is
  forced to `no_content` and stamped `+boilerplate-guard`, so a guarded decision
  is never mistaken for a model's. Checked against all six real transcripts and
  against the two borderline cases it must not catch, including the narrated
  D'Arce that Haiku wrongly wanted to exclude.

### Still open

Nothing pages when a `search_transcripts` call fails for a reason other than the
surface being down. The caller does see it (`search.ts:115-121` returns
"retrieval unreachable"), so it is not silent to whoever asked.
