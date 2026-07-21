# Architecture

`zencub-rag` is a standalone RAG app that treats a Supabase `rag_` table set of BJJ video-transcript data as its retrieval corpus.

## Boundaries

- This repo owns the RAG UI, RAG API routes, embedding jobs, and answer generation.
- Transcript ingestion, transcription, and technique extraction happen in an upstream pipeline, outside this repo.
- A fresh user-owned Supabase project can be bootstrapped with `docs/migrations/2026-07-17-rag-core-bootstrap.sql`; the import contract and safe setup sequence are documented in `docs/BRING_YOUR_OWN_DATABASE.md`.
- The RAG app should not write to non-`rag_` tables.
- Source data enters through deliberate sync jobs, never live writes.

## Retrieval Flow

Initial text-search flow:

```text
Search tab
  -> GET /api/rag/search?q=...
    -> createServerSupabase()
      -> rpc("search_rag_transcript_chunks")
        -> rag_transcript_chunks text search
          -> cited transcript snippets
```

1. User enters a query.
2. `/api/rag/search` validates the query and limit.
3. The route creates a server-only Supabase client with `SUPABASE_SERVICE_ROLE_KEY`.
4. Supabase calls `search_rag_transcript_chunks`.
5. The API returns transcript chunks with citations and metadata.
6. The UI displays source title, timestamp, platform/channel, rank, source link, and snippet.

Analyze Results flow:

```text
Search tab
  -> POST /api/rag/analyze { query }
    -> rerun search_rag_transcript_chunks
      -> trim top 8 chunks
        -> small/fast model via OPENAI_API_KEY
          -> structured watch plan with citations
```

`/api/rag/analyze` does not trust arbitrary transcript text from the browser. It receives the query, reruns retrieval on the server, and only sends the top retrieved chunks to the model. The model is configured by `RAG_ANALYZE_MODEL` and defaults to `gpt-4o-mini`.

Semantic search flow:

```text
Semantic Search button
  -> GET /api/rag/vector-search?q=...
    -> embed user question with RAG_EMBEDDING_MODEL
      -> rpc("match_rag_transcript_chunks")
        -> embedded transcript chunks
          -> meaning-ranked results
```

All 12,104 transcript chunks are embedded for end-to-end validation.

Ask flow:

```text
Ask button
  -> POST /api/rag/ask { query, retrieval: "auto" }
    -> retrieve vector + text candidate pools in parallel
      -> drop degenerate chunks (~120 char / ~30 token floor)
        -> fuse with Reciprocal Rank Fusion (no score threshold)
          -> cap to 2 chunks per video for source diversity
            -> LLM rerank the pool by intent
              -> enrich top chunks with overlapping rag_techniques metadata
                -> answer model prompt
                  -> cited answer JSON
```

`/api/rag/ask` is the first open-ended RAG endpoint. It retrieves sources server-side, sends only those sources to the selected answer engine, and returns answer text, citations, takeaways, follow-up searches, and caveats. The selectable engines are local Qwen, OpenRouter Qwen3 235B A22B, Claude CLI, and OpenAI. Auto mode fuses vector and text with RRF and reports `hybrid`, or `text`/`vector` when only one retriever returns candidates. Retrieval helpers live in `src/lib/ragRetrieval.ts`. The OpenAI answer model is configured by `RAG_ANSWER_MODEL`, the OpenRouter model by `RAG_OPENROUTER_MODEL`, and the reranker by `RAG_RERANK_MODEL` (`RAG_RERANK=off` disables it).

The database-native versions of hybrid fusion, the HNSW/GIN indexes, and optional degenerate-chunk cleanup are in `docs/migrations/2026-07-07-hybrid-rrf-index-cleanup.sql` for running in the Supabase SQL editor.

Experimental follow-up flow:

```text
LangGraph · Experimental toggle
  -> POST /api/rag/graph-follow-up
    -> restore conversation + context from the Postgres checkpoint for thread_id
      -> contextualize: rewrite the follow-up and classify same topic vs new topic
        -> retrieval subgraph: vector + keyword + metadata + prior context in parallel
          -> fuse with RRF and rerank by intent
          -> enrich timestamps and technique metadata
            -> generate with the currently selected answer provider
              -> validate citations against retrieved sources
                -> return answer + node trace
```

This path is deliberately separate from `/api/rag/ask`. Classic remains the default. Both paths use the shared primitives in `src/lib/ragPipeline.ts`, so retrieval math cannot silently drift. The graph supports all answer providers and server-side fallback, but adds durable thread state, topic routing, a private retrieval subgraph, and citation validation. `rag_followup_experiment_runs` stores server-only evaluation telemetry after `docs/migrations/2026-07-15-followup-experiments.sql` is installed; missing telemetry never blocks a user answer.

The parent graph compiles with `PostgresSaver`. The retrieval subgraph owns its vector, keyword, metadata, and prior-context pools; only fused/reranked results and trace entries return to parent state. Run `docs/migrations/2026-07-17-langgraph-persistence.sql` and `npm run langgraph:setup` before enabling the route.

The Phase 3 note workflow uses a separate checkpoint thread and pauses in `review_note` before any write. `/api/rag/graph-note` resumes approve/edit/reject decisions with `Command`; only the later `write_note` node can upsert `rag_research_notes`. Phase 4 adds an explicit local test-mode reranker failure and `/api/rag/graph-follow-up/recover`; `rag_langgraph_test_events` verifies that completed retrieval nodes are restored rather than repeated.

Checkpoint time travel is also test-mode only. A new thread opts in with `enable_checkpoint_replay: true`; the browser receives a random capability while the database stores only its hash in `rag_langgraph_replay_threads`. `/api/rag/graph-follow-up/checkpoints` requires that capability and an exact UUID, returns a redacted root-checkpoint timeline, and never provides a thread-enumeration route. Replay copies the selected checkpoint and its channel blobs under a new branch thread, then uses LangGraph `updateState` to create a fork checkpoint for branch-local test configuration. Resuming the fork reuses state before the boundary. The original thread is read-only throughout.

Instructor comparison is a separate checkpointed graph behind `/api/rag/instructor-compare`:

```text
comparison question
  -> private retrieval subgraph
       vector search*  ─┐
       keyword search  ├─ RRF fuse + per-video diversity
       technique data ─┘
  -> canonical person attribution (confidence >= 0.7)
  -> relevance ranking + instructor-diverse panel
  -> deterministic evidence gate --weak--> targeted retrieval --┐
       ^---------------------------------------------------------┘
  -> interrupt: human approves/removes clips/rejects
  -> dynamic Send fan-out
       instructor A analysis ─┐
       instructor B analysis ─┼─ synthesis -> per-claim verifier fan-out
       instructor C analysis ─┘
  -> deterministic quality gate -> durable turn
       ├─ same-thread follow-up reuses the approved panel
       └─ model experiment clones the approved-panel checkpoint
```

`*` Instructor Compare defaults to Qwen3 235B after it produced stronger validated comparison coverage in the initial live test. The optional Local Qwen mode disables the OpenAI query-embedding branch, leaving keyword and technique metadata active so the entire run has zero paid model calls. Qwen3 235B and GPT-4o Mini enable the semantic branch when OpenAI embeddings are configured. Analysis, synthesis, and any invoked evidence reranker use the selected provider. Every structured generation call records its exact provider/model, elapsed milliseconds, and provider-reported prompt/completion/total tokens; embedding tokens are not part of that generation total.

`rag_video_attributions` links the internal `rag_videos.id` UUID to `rag_creators.slug`; transcript chunks use the external `rag_videos.video_id`, so attribution is performed through the video table. Only creator records whose effective kind is `person` are eligible. This prevents a channel or publisher from being displayed as an instructor. Panel construction also conservatively collapses obvious short/full first-name duplicates sharing a surname (for example Jon/Jonathan Thomas) when the canonical data contains two records. Each analysis branch receives only that instructor's selected evidence. A bounded quality loop issues a gap-specific retrieval query when the panel lacks instructor/video coverage. Guided runs pause with `interrupt()` before analysis; a per-thread HMAC capability is required to approve, edit, reject, follow up, recover, or branch. Consensus and difference claims fan out to independent model verifiers and are removed unless both the verifier and deterministic two-instructor citation rules pass. Private retrieval pools, transcript text, graph state, and the server signing secret never appear in the API response.

Follow-ups invoke the same terminal thread with a new question, retain the approved panel, merge distinct new evidence, and store a new turn. Experiments clone the latest approved-panel checkpoint into a separate UUID thread and change only the selected provider, preserving the original. Instructor branch outputs are cached in server-only `rag_instructor_compare_branch_cache`; after a failed parallel superstep, successful branches are reused and only the missing branch calls the model again.

After validation, the route inserts that same safe API response into server-only `rag_instructor_compare_runs`. The history API selects only the stored result and its ID/timestamp; denormalized metrics support future evaluation queries without exposing private candidates. The Instructor Compare tab loads the newest 100 runs and can reopen the complete immutable result after a browser or server restart. Direct `anon` and `authenticated` table access is revoked.

## Visual Map In The App

The home page has five tabs:

- `Search`: text search, semantic search, Analyze Results, and Ask.
- `In App Experience`: an answer-first interface using the public app providers.
- `Instructor Compare`: canonical-person selection, parallel instructor analyses, synthesis, validation, and a guided explanation of the live graph.
- `System Map`: a visual chart of source snapshot -> chunks -> retrieval -> embeddings -> generated answers.
- `Lang Tests`: a runnable Classic-versus-LangGraph contract test plus the dependency-ordered durability, subgraph, interrupt, recovery, evaluation, and security plan.

The System Map shows embeddings and generated answers as live, with the embedded count showing current partial vector coverage.

It also includes:

- a plain-English RAG definition
- common RAG use cases
- clickable test queries that run against `/api/rag/search`
- table roles for each `rag_` table
- current embedding coverage

The detailed LangGraph test architecture and acceptance criteria live in `docs/LANGGRAPH_TEST_PLAN.md`. Phases 1 through 4, including checkpoint replay, are implemented; the tab includes restart, approval, failure-recovery, and original-versus-branch timeline tests and identifies LangSmith evaluation as the next phase.

Mutation and fault-injection labs are deployment-gated: note approval/writes, deterministic recovery, and checkpoint replay return 403 unless `LANGGRAPH_TEST_MODE=on`. Public environments must leave the flag off. Normal read/answer workflows do not accept these controls.

## Example Evaluation

The evaluated examples live in `src/lib/ragExamples.ts`. The UI imports the same list that the evaluator uses, so displayed examples and test cases cannot drift.

Run:

```bash
npm run eval:queries
```

Generated-answer evaluation is not automated yet. Current manual checks cover `/api/rag/ask` for knee-cut questions and verify returned answer text, retrieval mode, model, source count, citations, and watch URLs.

The evaluator checks each example by calling the app API:

```text
ragExamples.ts
  -> scripts/evaluate-rag-examples.ts
    -> GET /api/rag/search?q=...
      -> result count, expected terms, citations, source URLs
        -> docs/evals/rag-search-eval.md
```

## Table Roles

| Table | Role |
| --- | --- |
| `rag_videos` | Video title, source URL, platform, channel, thumbnail, slug |
| `rag_video_transcripts` | Raw transcript JSON segments and transcript metadata |
| `rag_techniques` | Technique names, positions, summaries, steps, timestamps |
| `rag_video_attributions` | Creator/instructor attribution links |
| `rag_creators` | Canonical creator names, aliases, opt-out field |
| `rag_transcript_chunks` | Searchable timestamped evidence chunks |
| `rag_search_logs` | Server-only query/action analytics |
| `rag_followup_experiment_runs` | Server-only experimental follow-up timing, routing, and traces |
| `rag_research_notes` | Server-only notes saved after explicit LangGraph approval |
| `rag_langgraph_test_events` | Server-only deterministic failure/recovery execution counters |
| `rag_langgraph_replay_threads` | Server-only replay capability hashes and original/branch provenance |
| `rag_instructor_compare_runs` | Server-only redacted Instructor Compare outputs and quality-review metrics |
| `rag_instructor_compare_branch_cache` | Server-only idempotency cache for selective instructor-branch recovery |

## Privacy Rule

Public/global RAG can use public transcript snapshots. Private/local imports need user-scoped retrieval and must not be mixed into global retrieval.
