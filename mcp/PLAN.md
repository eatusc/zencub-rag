# ZenCub RAG MCP Server - Plan

An MCP server that lets a model answer any question about the ZenCub RAG corpus
by querying the database directly, instead of guessing from what it remembers.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done and verified.

## Why this exists

A second way into the corpus, for a model rather than a browser.

`search.zencub.com` puts one query in front of a person who reads the results
and decides what to do next. This server puts the same retrieval in front of a
model that can chain without a human clicking between steps: search, pull the
surrounding transcript on the best hits, check what else those instructors
cover, then answer with timestamps. That chaining is the whole differentiator.
**A single search tool that mirrors the website adds nothing**, which is why the
object tools built in Phase 1 are not a detour: they are the follow-up surface,
and search is the entry point that was missing.

Two kinds of question, both served:

- **Content questions** ("what does Danaher say about the knee cut") need
  retrieval. This is the primary purpose. Phase 2.
- **Analytical questions** ("which positions are underrepresented", "how many
  videos per instructor", "what are people searching for") need SQL. No amount
  of chunk retrieval will ever count anything correctly. Phase 1, done.

### Why MCP and not an API

Both, over one core. The HTTP API already exists: 16 routes under
`src/app/api`, including `/api/rag/search`, `/api/rag/vector-search` and
`/api/rag/ask`, all over `src/lib/ragPipeline.ts`. That serves the website and
every non-model client (`zencubios`, partners, cron). MCP is a thin adapter on
the same core for model clients, and buys one thing the API does not: the tool
descriptions and corpus caveats travel with the server, so a model receives
"only `person` creators are instructors" and "these counts are as of the last
prod sync" without any of it being pasted into a prompt. Not an either/or, and
not a reason to build retrieval twice.

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Database | ZenCub **TEST**, the project named by `RAG_TEST_PROJECT_REF` | Production is never touched by this repo. Asserted at startup against that variable, not inherited from whatever the environment holds. Refs stay out of tracked files: this repository is public. |
| Scope | `rag_*` corpus only | TEST holds 61 tables in `public` plus the `auth` schema, covering accounts, authentication, and billing. None of it is the MCP server's business. Names stay out of tracked files; this repo is public. |
| Enforcement | Postgres grants, not SQL string filtering | A regex on SQL is a guess. A role with no grant on `public` is a fact. |
| Credential | New `zencub_mcp_reader` login role | Never `SUPABASE_SERVICE_ROLE_KEY`, never `LANGGRAPH_DATABASE_URL` (that one is the owner: full read *and write* on everything). |
| Transport | stdio first, HTTP later | Phase 1 is local Claude Code: no tokens, no exposed port. `/api/mcp` over Streamable HTTP is Phase 4, once the tool surface stops moving. |
| Retrieval implementation | Call the app's core, never reimplement | `src/lib/ragPipeline.ts` already does RRF, rerank, diversity and timestamp refinement. A second implementation would drift silently, because retrieval regressions return worse clips rather than throwing. |
| Answer generation | None | The MCP client is already a model. Return evidence; let it synthesise. A nested LLM call adds latency, cost, and a second place for citations to drift. |

## Corpus facts (measured 2026-08-27, TEST)

Numbers the schema description must carry, because the obvious question has
several defensible answers and a model will pick one confidently:

| Thing | Count | Note |
| --- | --- | --- |
| `rag_transcript_chunks` | 14,274 | 100% embedded, 1536-dim |
| distinct videos with chunks | 2,847 | this is the searchable corpus |
| `rag_videos` | 3,032 | ~185 have no transcript |
| `rag_video_transcripts` | 2,847 | matches chunk coverage |
| `rag_techniques` | 3,432 | |
| `rag_creators` | 477 | 266 person, 206 channel, 5 publisher |
| `rag_video_attributions` | 2,846 | all at confidence >= 0.7 |

Two traps encoded in the views so the model cannot fall into them:

1. `rag_video_attributions.video_id` is the **internal uuid** (`rag_videos.id`),
   while chunks and techniques use the **external text** `rag_videos.video_id`.
   Joining them naively yields zero rows or nonsense.
2. Only creators whose effective kind (`coalesce(kind_override, kind)`) is
   `person` may be presented as instructors. Otherwise a channel like
   "BJJ Fanatics" gets displayed as a human. `src/lib/instructorComparison.ts`
   already encodes this; `v_instructors` carries it forward.

## Phase 0 - credential and schema scoping

The gate. Nothing else starts until this is applied and verified.

- [x] Write `migrations/0001-rag-mcp-schema-and-reader-role.sql`
- [x] Validate it against TEST inside `BEGIN; ... ROLLBACK;` (nothing persisted)
- [x] Generate the role password and apply the migration to TEST
- [x] Add `MCP_DATABASE_URL` to `.env.local`, key-only stub to `.env.example`
- [x] Run `scripts/verify-reader-role.sh --live`, green, summarised in `LOG.md`
- [x] Confirm the Supavisor pooler accepts the custom role (it does, both ports)

Views created in schema `rag_mcp`:

| View | Covers |
| --- | --- |
| `v_videos` | one row per video, with `has_transcript`, `chunk_count`, `technique_count` |
| `v_instructors` | people only, opt-outs excluded, with `attributed_video_count` |
| `v_creators` | all creator kinds, for channel/publisher questions |
| `v_video_instructors` | the uuid/text join done correctly, confidence >= 0.7 |
| `v_techniques` | technique cards without `raw_response` |
| `v_chunks` | chunks with metadata flattened, **no `embedding` column** |
| `v_search_logs` | site query telemetry, no IP or user identifier |
| `v_corpus_stats` | the single-row summary, so counting is one cheap call |

## Phase 1 - stdio server, structured tools

- [x] `src/server.ts` on `@modelcontextprotocol/sdk`, stdio transport, `pg` pool
- [x] Startup assertion: refuses to boot unless the DSN matches `RAG_TEST_PROJECT_REF`, and refuses a `postgres` owner DSN outright
- [x] **Enforce read-only and timeout in the client as well as the role.** The
      role's settings are live and verified, but a later `ALTER ROLE ... SET`
      will not reach warm pooled connections, so anything tunable must not
      depend on them. Set `statement_timeout` on pool checkout and wrap every
      query in `BEGIN TRANSACTION READ ONLY`. Done in `mcp/src/db.ts:147-148`;
      `health()` reports `read_only = on` live.
- [x] `describe_schema()` - columns, types, view purposes, corpus stats, and the which-view-for-which-question guidance
- [x] `corpus_stats()`
- [x] `query_sql(sql)` - read-only txn, `statement_timeout`, row cap, single statement
- [x] `get_video(video_id | slug)` - plus its instructors and techniques
- [x] `get_instructor(slug | name)` - plus videos and position coverage
- [x] `list_techniques(position?, type?, gi_nogi?, difficulty?, instructor?, name?)`
- [x] `get_transcript_window(video_id, start_seconds, end_seconds)`
- [x] `health()` tool, so a failing call can be attributed to server or query
- [x] Register with `claude mcp add --scope user` (user scope, not project: the
      path is machine-specific and this repo is public)
- [x] `mcp/scripts/smoke-test.ts`: 56 assertions over real MCP against the real
      database, all passing (37 at Phase 1, plus 19 for filter validation)

No model provider keys needed for any of these. Pure SQL.

## Phase 2 - search: the primary purpose

Phase 1 built the follow-up surface. This builds the entry point, and turns the
server from an analytics tool into a second way to search the corpus.

### How to reach the retrieval core

Two options, decide by spike, do not write a third implementation.

- [x] **Spike A, in-process. Viable, and disqualified.** Ran 2026-08-28.
      No `tsx` needed: `mcp/scripts/alias-hook.mjs` is a 35-line
      `module.registerHooks` resolver that maps `@/*` to `src/*` and supplies
      the file extension that bundler resolution omits. With it,
      `node --experimental-strip-types` imports `ragPipeline`, `ragRetrieval`,
      `ragUtils` and `timestampRefinement` cleanly, all five expected exports
      present (`mcp/scripts/spike-retrieval-import.ts`, 10/10 pass). The import
      graph is `openai`, `@supabase/supabase-js` and `@/lib/*` only, with no
      `next/*` anywhere, transitively confirmed.

      **Disqualified on credentials, not on feasibility.** Every retrieval
      function reaches the database through `createServerSupabase()`
      (`src/lib/supabase.ts`), which builds its client from
      `SUPABASE_SERVICE_ROLE_KEY`. Importing the core in-process therefore
      requires that key in the MCP process: full read and write on all 61
      tables, RLS bypassed. That is the exact credential the Phase 0 locked
      decision forbids and the entire reader-role migration exists to avoid.
      Feasible is not the same as allowed.

      The hook stays: it is still the right way to import pure functions with no
      database dependency, such as `formatRagSource` in `ragUtils`.

- [x] **Spike B, over HTTP. Chosen.** Ran 2026-08-28 against the launchd
      instance on `http://127.0.0.1:3418`. `/api/health` 200;
      `/api/rag/search?q=` returns 12 results in **272ms, 306ms and 516ms**
      across three queries. Fast enough that latency is not a reason to prefer A.

      Each result carries `id`, `video_id`, `chunk_index`, `start_seconds`,
      `end_seconds`, `text`, `rank`, and a `metadata` object holding
      `video_title`, `channel_name`, `video_url`, `platform`, `slug`,
      `thumbnail_url`, `instructor_name` and a preformatted `citation`
      ("2026 Polaris 37 @ 23:25"). That is everything the chaining requirement
      and the deep-link field need, with no second lookup.

**Decision: B.** The service-role key stays inside the Next process, the MCP
server holds no credential beyond `zencub_mcp_reader`, and both surfaces share
exactly one retrieval path so they cannot diverge. Enrichment beyond what the
endpoint returns is done through the reader role against `rag_mcp`, which keeps
the split clean: HTTP for ranking, reader role for corpus facts.

### The tool

- [x] `search_transcripts(query, mode = hybrid | text | semantic, limit,
      video_id?, instructor?, position?)` Shipped as
      `search_transcripts(query, mode, limit, filter)`.
- [x] **Results must carry the handles the follow-up tools need.** Each hit
      returns `video_id`, `start_seconds`, `end_seconds`, `instructor slug`, and
      a deep link, so the model can go straight to `get_transcript_window`,
      `get_instructor` or `get_video` without another lookup. Chaining is the
      differentiator; a result set that dead-ends throws it away.
- [x] **Deep link plus precision on every hit**, per Phase 5. YouTube gets
      `watch?v=<id>&t=<n>s` (rewriting the 52 `/shorts/` URLs first); TikTok and
      Instagram get video-level only; `local:` gets none. Never emit a timestamp
      link that lands at 0:00.
- [x] Degrade to text-only when `OPENAI_API_KEY` is absent, and say so in the
      response, rather than failing or silently returning worse results.
      `mcp/src/search.ts:107-111` pushes an explicit warning.
- [ ] Log to `rag_search_logs` under a distinct action so MCP traffic does not
      pollute the public-site analytics, and so this server's own retrieval
      quality is measurable next to the site's.

### Blocked on the relevance gate

- [ ] `search_transcripts` must not ship before the fix in Phase 5 Tier 1.
      2,912 chunks, 20.4% of the corpus, come from 284 videos the pipeline
      rejected as non-instructional (competition livestreams, MMA fight-analysis
      AMAs, debates, interviews). They are fully embedded and
      `match_rag_transcript_chunks` filters only on `embedding IS NOT NULL`, so
      the first thing this tool would do is return FloGrappling commentary as
      instruction. The gate belongs upstream in
      `zencub/scripts/rag-sync-prod-snapshot.ts` and both retrieval RPCs, where
      it protects the website and this server at once.

## Phase 3 - hardening

- [x] **Reject unknown filter values instead of returning an empty set.** Done
      2026-08-28 in `mcp/src/enums.ts`, wired into `list_techniques`. Found
      2026-08-27: `list_techniques(gi_nogi: "nogi")` returns 0 rows with
      `truncated: false` while the stored value is `no_gi` and the true answer is
      28. A plausible spelling produced a confident, clean, wrong answer. Every
      other failure in that session announced itself; this one succeeded
      quietly, which is worse. Validate `gi_nogi`, `position`, `type` and
      `difficulty` against the distinct values and return
      `no such value 'nogi'; valid: gi, no_gi, both`. This is the defining
      failure mode for model-facing tools: not the error, the well-formed wrong
      answer.

      **A second, worse instance of the same bug surfaced while fixing it.**
      The filters were `ILIKE '%value%'`, and `'no_gi' ILIKE '%gi%'` is true, so
      `list_techniques(gi_nogi: "gi")` returned **no_gi cards**. Not an empty
      set: the opposite of what was asked, in well-formed rows. The real split
      is gi 630, no_gi 234, both 2,524, null 44, so the wrong answer looked
      plausible too.

      Shipped: `gi_nogi`, `type` and `difficulty` are matched **exactly**
      against the live distinct values after canonicalising case and
      punctuation, so `nogi`, `no-gi`, `No Gi` and `NO_GI` all resolve to
      `no_gi` while `gi` can no longer match `no_gi`. Canonicalisation is
      checked for injectivity at load time and the field degrades to
      exact-spelling if two stored values ever collide. `position` stays a
      substring match, because its columns are hierarchical on purpose, but an
      unknown position is refused and the values it matched are reported back.
      An unknown `instructor` slug is refused with near misses named, rather
      than answered with "this instructor has no techniques", which is a
      different claim. A cache miss forces one reload before refusing, so a
      stale vocabulary can never reject a value the corpus has since gained.
      Every call echoes `filters_applied`.

      19 assertions in `smoke-test.ts` cover it, including that `gi` and `no_gi`
      are disjoint and that `type: "guard_retention"` does not leak `guard`.
      This plan previously recorded the true `nogi` answer as 28; measured
      2026-08-28 it is **234 cards over 141 videos**, and 28 is not reproducible
      from `gi_nogi` alone (`no_gi` + `advanced` = 27 is the nearest reading).
- [ ] Tests: reader role cannot reach `public`; `query_sql` rejects non-SELECT,
      multi-statement, and CTE-wrapped writes; row cap and timeout hold
- [ ] Test: schema description counts match live counts (they will drift)
- [ ] **Failure reporting.** Per the standing rule, nothing runs in the
      background without being able to say it broke. Decide the path: health
      tool plus Telegram on repeated tool errors, or fold into the jobs audit.
      A server that only ever reports success is indistinguishable from a dead one.

## Phase 4 - optional

- [ ] `/api/mcp` Streamable HTTP inside the Next app, bearer auth, for Claude
      Desktop and phone
- [ ] `compare_instructors` as a thin call into the existing LangGraph workflow,
      behind an explicit budget the way the public site already does

## Phase 5 - consumer-grade answers

Everything above serves the corpus owner. This phase is what changes if a
member, not Eric, is the one asking. Measured against TEST on 2026-08-27; the
counts are the argument, so they are recorded here rather than asserted.

Not started. Phase 2 is a hard prerequisite for the whole tier: without
semantic retrieval a member's natural phrasing returns nothing. "how do I stop
gassing out" scores 0 literal chunk hits and 123 concept-word hits.

### Tier 1 - blocking

- [ ] **Content gate, scoped to MCP first. The live sites are not touched.**

      **`martial_arts_relevance` has four states, not three, and one of them
      is "never ran".** Found 2026-08-28 while chasing the three finance videos
      in the corpus. They are not a curiosity, they are a visible corner of a
      population:

      | source | status | relevance | videos | chunks |
      | --- | --- | --- | --- | --- |
      | user_submitted | analyzed | **NULL** | 125 | 643 |
      | batch_import | clips_done | **NULL** | 16 | 48 |
      | batch_import / user_submitted | other | **NULL** | 9 | 27 |
      | batch_import | analyzed | uncertain | 263 | 883 |
      | user_submitted | analyzed | uncertain | 5 | 24 |

      **150 videos / 718 chunks were never classified at all**, and a further
      **268 videos / 907 chunks are `uncertain`**, a value
      `src/lib/types.ts:123` does not even admit exists (it types the column
      `"yes" | "no" | null`).

      **Root cause of the NULLs, read in the code rather than inferred.**
      `src/app/api/user/import/route.ts:258` passes `skipRelevanceCheck: true`
      for every user-submitted video, deliberately -- its comment says
      "Preflight is the commitment gate. Once the user confirms, we run the
      pipeline regardless... and we charge regardless of the result."
      `src/lib/pipeline.ts:297` guards the only write with
      `if (!skipRelevanceCheck && !transcriptOnly)`, so for user submissions the
      column is never written and stays NULL. Every one of the three finance
      videos is `source = user_submitted`. The 21 `batch_import` NULLs are a
      separate, closed population: all created between 2026-04-16 and 04-20,
      before the check was wired in.

      `checkMartialArtsRelevance` (`src/lib/ai/quality.ts:108-131`) also reads
      **only the title and channel name**, never the transcript, and returns
      `uncertain` both when metadata is weak and when the LLM call throws. So
      the flag is a title classifier with a silent failure mode, which is the
      second reason not to build a retrieval gate on it.

      **Consequence, verified live rather than reasoned about.**
      `search_transcripts(query: "bitcoin four year cycle", filter: "flagged")`
      returns three chunks of Benjamin Cowen on Bitcoin cycles, `removed_by_filter`
      empty, with `instructor_name: "Benjamin"` attached. `filter=flagged` tests
      `status=failed AND relevance=no`; NULL and `uncertain` sail through it.

      **Do not gate on `martial_arts_relevance = 'no'`.** That flag answers
      "is there a technique to extract from this video", not "is this useful to
      a practitioner". The two questions agree on livestreams and disagree on
      coach AMAs and interviews, and reusing it as a retrieval gate silently
      drops 1,021 chunks of training-adjacent knowledge. Corrected 2026-08-28
      after reading the removed text rather than trusting the titles.

      The underlying inconsistency is still real: the pipeline's relevance
      decision is honoured by technique extraction and discarded by retrieval.
      `pipeline.ts:1037-1044` sets `status='failed', martial_arts_relevance='no'`
      on a `MartialArtsRelevanceError` and stops extraction, but chunking and
      embedding already ran; `rag-sync-prod-snapshot.ts:76-78` copies both
      columns and filters on neither; and `match_rag_transcript_chunks`
      (`docs/migrations/2026-07-17-rag-core-bootstrap.sql:153-155`) is
      `WHERE embedding IS NOT NULL` with no join to `rag_videos` at all. Three
      call sites share those two RPCs (`ragPipeline.ts:59,73`,
      `askGraph.ts:106,120`, and `instructorCompareGraph.ts:220,230` via
      `ragPipeline`), so a fix at the RPC level covers all of them, and so does
      the blast radius: both public sites at once.

      **What the 2,912 flagged chunks actually contain**, by reading them:

      | bucket | videos | chunks | verdict |
      | --- | --- | --- | --- |
      | event / stream coverage | 21 | 961 | safe to exclude, verified |
      | coach AMA / fight analysis | 13 | 616 | **keep**, carries real advice |
      | interview / discussion | 7 | 405 | keep, judgment call |
      | other, mostly small clips | 243 | 930 | **read 2026-08-28, mixed, see below** |

      **Bucket 4, read in full on 2026-08-28** (all 243 videos, all 930 chunks,
      across the three size bands: 54 videos at >=5 chunks, 49 at 2-4, 140 at 1).
      "Mostly small clips" was wrong in the way that mattered. It is dominated
      by *instructional* channels, not promo: Bernardo Faria 25 videos / 55
      chunks, Chewjitsu 10 / 47, ART OF JIU JITSU 19 / 42, Keenan Cornelius
      9 / 38, Matt Arroyo 24 / 32, Andrew Wiltse 6 / 22, Brian Glick 2 / 19.
      FloGrappling is the largest single block at 32 / 199 and is event
      coverage.

      Three things it contains that a wholesale exclusion would have destroyed:

      1. **Straight technique instruction.** Brian Glick's "Beginners Guide To
         Inside Camping" is six chunks of half-guard teaching -- "move our hand
         to our partner's hip, our second hand to our partner's knee". Knight
         Jiu-Jitsu's "Handgun Choke Guard Pass" is a taught pass in one chunk.
         Both were rejected as not martial arts.
      2. **Physical preparation, which is instruction.** Two Scott Georgeaklis
         videos on BJJ Fanatics, "Foam Roller Work for Lower Extremity" and
         "Roller Hip And Shoulder Reset", 13 chunks between them. This is the
         same category as the Zahabi back-pain AMAs and the same argument.
      3. **Training advice at scale.** Chewjitsu on a 56-year-old brown belt
         being disrespected by a younger purple belt; Keenan on student
         retention, gym culture and coaching; Kesting on training around a
         newborn and on what belts mean; Bernardo's whole short-form series on
         motivation, comparison and competition nerves; BJJ After Forty on black
         belt attrition; a first-hand account of being stalked at a gym.

      And one category the plan did not have, which the read forced:

      4. **`no_content`: the transcript contains no speech about the subject.**
         Titles promise a technique and the transcript is song lyrics over
         silent footage. "Keenan Cornelius passing lapel guards" is five chunks
         of "♪♪". Cobrinha's "Guard Passing Drills" is "I love you. I love you."
         "Next level Guard passing" is "The thing about the potato." Two "Lachy
         lock" videos are rap verses. AOJ's Asian Championships finals are
         Japanese venue PA announcements. A FloGrappling highlight is the word
         "Heat." seven chunks long. These are embedded and retrievable today and
         can only ever be a wrong answer.

      **`no_content` cannot be found with heuristics, measured 2026-08-28.**
      Bracket-marker ratio (>35% of characters inside `[...]`) plus non-Latin
      script (<80% ASCII) flag **231 chunks in the whole 14,274-chunk corpus**;
      near-empty and highly-repetitive chunks add ~108 across the flagged set.
      Song lyrics are statistically indistinguishable from speech, so every
      lyric-only video passes every cheap test. This needs a model that reads
      the text, which is why it is a `content_kind` value and not a filter.

      Event coverage is confirmed worthless. The chunks a keyword probe flagged
      as instructional inside "LIVE: Watching Colored Belt MANIA" read "Boom.
      What's up everybody? Welcome back to the IBJF World Championship" and
      "get subscribed... Portofly chat's back". The probe matched on "anything
      you want to know" and "you guys".

      The Zahabi AMAs are the opposite, and are why the flag is wrong: "to
      alleviate sciatic pain... finding knots in your glutes and your hips and
      how to knead the muscle" and "I teach you how to decompress your back
      while you're sitting in a chair... posture, alignment, decompression".
      That is training-longevity coaching, and "my back hurts from training" is
      a practitioner question.

      **Order of work. The first three steps cannot change a single result on
      search.zencub.com or instructors.zencub.com.**

      1. ~~Add `retrievable boolean`~~ **Superseded by step 4.** Bucket 4
         turned out to be mixed rather than excludable, and the read produced a
         sixth class (`no_content`) that a boolean cannot express, so labelling
         chunks by hand stopped being the cheap first move. Going straight to
         `content_kind` costs the same and answers more.
      2. [x] **Read bucket 4 before touching it.** Done 2026-08-28, all 243
         videos and 930 chunks. Findings in the bucket table above. It is not
         all promo clips: it holds real instruction, real physical prep, a large
         body of training advice, and the `no_content` class.
      3. [ ] `search_transcripts` (Phase 2) filters on `content_kind`. New tool,
         no users, nothing to regress.
      4. [~] Classify `content_kind` properly:
         `instruction | training_advice | event_coverage | interview |
         promotional | no_content`. Gate on `event_coverage` and `no_content`.
         This is the signal actually wanted, and it keeps the back-pain, mindset
         and history content a practitioner would search for. The last two
         values were added after reading bucket 4; see the bucket table.

         **Drafted 2026-08-28, not applied, not run.**
         `mcp/migrations/0002-content-kind.sql` adds `content_kind`,
         `content_kind_confidence`, `content_kind_model` and `content_kind_at`
         to `rag_videos`, a CHECK constraint over the six values, a partial
         index, and the columns on `rag_mcp.v_videos`. Nullable with no default
         on purpose: NULL means "not classified", which the 150 NULL
         `martial_arts_relevance` rows prove is a different statement from any
         value. Validated against TEST inside `BEGIN; ... ROLLBACK;`, clean.
         Deliberately not `DROP VIEW ... CASCADE`: nothing depends on `v_videos`
         today (0 rows from `pg_depend`), so CASCADE would buy nothing and could
         silently drop a dependent added later.

         `mcp/scripts/classify-content-kind.ts` classifies from a transcript
         sample spread across the whole video, not the head, because intros lie
         in both directions. Writes go through the owner DSN, never the reader
         role, and are committed per video so a run that dies at 80% keeps the
         80% and resumes on `content_kind IS NULL`. A model value outside the
         enum is a failure, never coerced to a neighbour.

         **Graded before trusting it**, against `mcp/scripts/gold-content-kind.ts`:
         28 videos labelled by hand from their transcripts, covering all six
         classes. `anthropic/claude-haiku-4.5` scores **24/28 (86%)**, above the
         85% bar the script exits non-zero below.

         Right on the parts that motivated the work: **5/5 on `no_content`**,
         including the three lyric-over-technique-title cases; and every
         wrongly-flagged instructional video recovered, including "Beginners
         Guide To Inside Camping", the foam roller video and "Handgun Choke
         Guard Pass".

         **Not good enough to run yet, and the reason is specific.** All four
         misses sit on the `event_coverage` / `interview` boundary, which is
         exactly the boundary that decides exclusion, and two of them push a
         keeper into the excluded class: Zahabi's round-by-round Khamzat
         analysis and the Nathan Haddad ADCC documentary both came back
         `event_coverage`. The prompt is at fault, not the model -- it lists
         "MMA fight analysis" under `interview` and "competition commentary"
         under `event_coverage`, and a round-by-round recap of one fight is
         literally both. Sharpen that distinction, re-run `--eval`, and only
         then classify the corpus.
      5. **Only then** consider the site, behind a fresh measurement.
      6. If the site does get the gate: `CREATE INDEX CONCURRENTLY` the partial
         HNSW and FTS indexes alongside the existing full ones first, so there is
         never a window without an index; edit the two RPCs last, since that one
         step is the whole behaviour change and reverting it reverts everything;
         drop the old indexes only once satisfied. Never filter with a join
         against an `ORDER BY embedding <=> query`, which can push the planner
         off HNSW.

      **Measured impact of the rejected flag-based gate, text-match proxy,
      2026-08-28.** Kept for reference because it bounds the event question, and
      because the narrower gate in step 1 removes strictly less. These bound
      availability, not ranking: semantic retrieval orders differently, so
      re-measure against real `search_transcripts` output before step 5.

      Instructional queries were effectively unaffected even by the wide gate:
      `escape side control` 13 to 13, `kimura` 253 to 249, `triangle choke` 89
      to 87, `guard passing` 107 to 97, `heel hook` 181 to 163, `armbar` 299 to
      281, `knee cut` 166 to 162.

      Event queries lost the most by count but kept the better sources: `adcc`
      378 to 183, `world championship` 299 to 93, `who won` 25 to 5. What
      survives for `adcc` is the edited material: the +99kg and -65kg 2024
      bracket supercuts (37 and 20 chunks), the full Nathan Haddad interview,
      "Top ADCC Referee Reveals The Secret To Winning Decisions". No tested
      query returned zero.

      **The gate is not a channel filter**, which was the main thing that could
      have made it crude. It discriminates inside channels: FloGrappling 50
      rejected and 72 kept (1,125 chunks), Tristar 33 and 44 (589 chunks), BJJ
      Fanatics 3 and 381.

      **End state for the site**: deprioritize and label rather than exclude.
      Excluding is right for a how-to tool; a search box people also ask about
      events wants ranking.
- [ ] **Deep links computed server-side, with an honest precision field.**
      Return `deep_link` plus `deep_link_precision` in
      (`timestamp`, `video_only`, `unavailable`). Never emit a timestamp link
      that silently lands at 0:00: that is the same failure class as the
      `nogi` empty result.

      | platform | techniques | timestamp link |
      | --- | --- | --- |
      | youtube | 2,974 | yes, `watch?v=<id>&t=<n>s` |
      | tiktok | 232 | no, video only |
      | instagram | 180 | no, video only |
      | local | 46 | none, `local:` URI |

      Two traps: 52 videos carry `/shorts/` URLs, which do not honour `&t=` and
      must be rewritten to the `watch?v=` form; and Instagram reels hold
      techniques as deep as `start_seconds = 216` that cannot be linked into at
      all.
- [ ] **Phase 2 semantic retrieval.** Nothing else in this tier matters first.

### Tier 2 - trust

- [ ] **Expose `quality_flags`; stop exposing `approval_status` alone.**
      `rag_mcp.v_techniques` currently surfaces the field production says not to
      use and hides the one it does. See the resolved open question below. This
      still matters under a search-first scoping: `ragPipeline.ts:113-152`
      searches `rag_techniques` on name, position, type and gi_nogi *first* and
      maps the matching time ranges back onto transcript chunks, so card quality
      steers which chunks retrieval returns. Cards are part of the retrieval
      path, not a separate surface.
      Mirror the gate in `public.indexable_techniques`
      (`zencub/supabase/migrations/072_indexable_views.sql`) rather than
      inventing a second one: summary >= 50 chars, `steps` an array of >= 3, no
      flag among `no_steps, mostly_music, low_narration, non_english,
      uncertain_relevance`, and junk positions excluded.
- [ ] **A risk dimension separate from `difficulty`.** A 50/50 heel hook drill
      is tagged `fundamental`, so a beginner filtering for fundamentals is
      served heel hooks. Injury risk is not the same axis as skill level.
- [ ] **Split doing from escaping.** A name search for "rear naked choke"
      returns finishes and escapes interleaved. `type` already distinguishes
      them; the consumer tool must apply it rather than leaving it to whoever
      writes the query.
- [ ] **Never return raw ASR to a member.** The transcript for the Danaher side
      control escape reads "put me back in God", "wages around my opponent's
      body", "the basis of tinning", "Bernard afluria". The technique card for
      that same segment is clean. Retrieval may search `v_chunks.text`;
      presentation must use card summaries.

### Tier 3 - the tool surface is wrong for consumers

The seven Phase 1 tools are operator tools. `query_sql` and `describe_schema`
are meaningless to a member and are attack surface that buys nothing.

- [ ] `answer_question(question)` - retrieval, returns cards plus deep links
- [ ] `learn_position(position, level)` - ordered study list with links
- [ ] `find_instruction(technique)` - doing/escaping split handled
- [ ] `beginner_path()` - 979 unordered `fundamental` cards is not a curriculum.
      Nothing in the schema knows that one Gracie video happens to contain a
      coherent seven-technique sequence.
- [ ] **Attribution precision.** Danaher's 31 videos include "A rear naked choke
      detail I learned from John Danaher", a video about him credited to him at
      0.9. Consumer-facing attribution must separate authorship from mention.

### Tier 4 - not optional, not technical

- [ ] **Rights posture.** Deep-linking to the source with attribution is
      defensible; hosting extracted clips is a different position. 55 videos sit
      at `status = 'clips_done'` and 44 carry `local:` URIs, so decide
      deliberately before any member-facing launch. The creator opt-out already
      honoured by `v_instructors` is the right instinct.
- [ ] **Injury disclaimer.** This serves submission instruction to people who
      may train with an untrained partner.
- [ ] **Transport and auth.** A member cannot install a stdio server. Phase 4
      HTTP, or accept that the website is the consumer surface and this phase
      improves it by improving the data.

### If only three ship

The `retrievable` label plus the MCP-scoped filter (hours, and it cannot touch
the live sites), deep links with honest precision (a day), and Phase 2 (the real
work). Those take it from an operator tool to a beginner getting a correct
answer with a working link to the right moment, with the two public sites
returning exactly what they return today.

## Open questions

1. ~~**Supavisor and custom roles.**~~ **RESOLVED 2026-08-27 by measurement.**
   The pooler accepts a custom role as `<role>.<project-ref>` on both session
   (5432) and transaction (6543) mode. No direct connection, no IPv4 add-on, no
   dashboard configuration needed. `ALTER ROLE ... SET` does take effect through
   the pooler when set at role creation (verified: `on | 5s | rag_mcp` on both
   ports), but is effectively unchangeable afterwards while a pooled backend is
   warm. See Phase 1.
2. **`pg_stat_statements` is readable by every role.** Supabase ships it in the
   `extensions` schema granted to `PUBLIC`, so the reader role can see it too.
   It exposes normalised query text, not row data. Revoking from `PUBLIC` is a
   database-wide change, so `verify-reader-role.sh` treats it as a named
   exception and fails on anything else. Decide: revoke, or accept and document.
   `dashboard_user` has its own grant, so a revoke would not break the dashboard.
3. **Row cap for `query_sql`.** A 1536-float embedding row is ~30KB of context,
   which is why `v_chunks` drops the column entirely. Still need a sane default
   cap on returned rows, probably 200 with an explicit override.
4. **Does TEST drift from PROD?** The corpus was last refreshed from prod on
   2026-08-27 (`a4dcfc3`). Answers from this server describe TEST as of that
   refresh. Worth stating in `describe_schema` output so it is never mistaken
   for live production truth.
5. ~~**What does `approval_status = 'pending_review'` mean?**~~
   **RESOLVED 2026-08-27 by reading the writer.** It is not a human review
   queue and there is no backlog. `scoreExtraction()` in
   `zencub/src/lib/ai/quality.ts:226-270` computes it at extraction time: any
   one of `thin_extraction, low_narration, mostly_music, non_english,
   uncertain_relevance, timestamp_drift, step_count_unusual, no_steps` flips a
   card to `pending_review`. Three of those eight are structural rather than
   content quality, and `step_count_unusual` fires on any card with fewer than
   3 or more than 12 steps, which is why 3,357 of 3,432 cards carry the label.
   Production already treats it this way:
   `zencub/supabase/migrations/072_indexable_views.sql:7` states outright that
   "approval_status is an AI self-confidence flag and is NOT used here; the gate
   is quality_flags + structural checks."
   **Consequence for this server, tracked in Phase 5:** `v_techniques` exposes
   `approval_status` and drops `quality_flags`, so it surfaces the field
   production says to ignore and hides the one production actually gates on.
   `rag_techniques.quality_flags` (jsonb) exists and is synced. Add it, and
   mirror the `indexable_techniques` gate rather than inventing a second one.
