# ZenCub RAG

A LangGraph-powered Retrieval-Augmented Generation app that turns a BJJ (Brazilian Jiu-Jitsu) video-transcript library into a searchable, citation-backed research assistant. It combines persistent checkpointed workflows, parallel retrieval and instructor-analysis branches, human approval/recovery labs, hybrid keyword + semantic retrieval, and answers grounded in timestamped source clips.

It reads a read-only Supabase dataset of transcript data and never writes back to the source tables. All database access is server-side; secrets never reach the browser.

## Screenshots

| Search | System Map |
| --- | --- |
| ![Search tab](docs/media/search.png) | ![System Map tab](docs/media/system-map.png) |

> Add the two PNGs to `docs/media/` before publishing (run `npm run dev` and capture the Search and System Map tabs).

## Current Scope

- Hybrid retrieval over `rag_transcript_chunks`: keyword full-text search + semantic vector search fused with Reciprocal Rank Fusion
- LLM reranking and per-video result diversity for higher-signal top results
- Citation-oriented results using chunk metadata (title, channel, timestamp, source URL)
- Server-side Supabase service-role access only
- Full semantic-search coverage across the embedded transcript corpus
- Generated cited answers through `/api/rag/ask`, enriched with overlapping technique metadata
- Opt-in LangGraph follow-ups that classify topic continuity, retrieve context, and validate citations without replacing the classic path
- Home-page `System Map` tab visualizes the pipeline, corpus coverage, and table roles
- Home-page `Lang Tests` tab runs the live Classic-versus-LangGraph baseline and lays out acceptance tests for persistence, subgraphs, interrupts, recovery, LangSmith evaluation, and the write-to-vault security workflow
- Checkpointed human approval for research-note writes plus deterministic reranker failure/recovery tests
- Capability-authorized checkpoint timelines and separate-thread replay branches for local/test time-travel experiments
- A top-level `Instructor Compare` experience with adaptive evidence retrieval, human panel approval, parallel instructor and claim-verifier branches, persistent follow-ups, selective recovery, checkpoint-based model experiments, and a live visual state-machine explanation
- Durable, server-only Instructor Compare history with filtering, run-type labels, and a complete visual result modal after browser/server restarts

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

To use your own data, follow [Bring Your Own Database](docs/BRING_YOUR_OWN_DATABASE.md). It includes a fresh Supabase bootstrap migration, required import order and JSON contracts, embedding backfill, RLS/security rules, and optional LangGraph setup. This repository does not include or copy the author's database contents.

Required env:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
RAG_ANALYZE_MODEL=gpt-4o-mini
RAG_ANSWER_MODEL=gpt-4o-mini
RAG_EMBEDDING_MODEL=text-embedding-3-small
RAG_RERANK_MODEL=gpt-4o-mini
RAG_OPENROUTER_MODEL=qwen/qwen3-235b-a22b-2507
RAG_RERANK=on
RAG_TEST_PROJECT_REF=YOUR_PROJECT_REF
LANGGRAPH_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres
LANGGRAPH_CHECKPOINT_SCHEMA=langgraph
LANGGRAPH_TEST_MODE=off
```

The browser never receives the service-role or model-provider keys. API routes own all database and model access.

Run `docs/migrations/2026-07-14-search-logging.sql` once in the Supabase SQL editor to create the server-only search history table. After that, keyword searches, semantic searches, analyses, Ask AI questions, and conversational follow-ups are logged automatically.

Run `docs/migrations/2026-07-15-followup-experiments.sql` once to create the optional, server-only `rag_followup_experiment_runs` table. The experimental follow-up still works before the migration is installed; only its evaluation telemetry is skipped.

For persistent LangGraph conversations, run `docs/migrations/2026-07-17-langgraph-persistence.sql`, then `npm run langgraph:setup` once. `LANGGRAPH_DATABASE_URL` must be a direct Postgres/pooler connection, not the Supabase HTTP URL. The first graph follow-up seeds existing answer context once; later turns send only `thread_id`, query, and provider.

Run `docs/migrations/2026-07-17-langgraph-approval-recovery.sql` for the server-only `rag_research_notes` and `rag_langgraph_test_events` tables. In explicit test mode, the Lang Tests tab can then pause proposed notes for approve/edit/reject and exercise checkpoint recovery. Both write/recovery APIs return 403 while `LANGGRAPH_TEST_MODE=off`; keep it off outside an intentional local test environment.

Run `docs/migrations/2026-07-17-langgraph-checkpoint-replay.sql` for the server-only replay authorization registry. In explicit test mode, a newly created thread may receive a random replay capability; only its hash is persisted. The checkpoint API requires that capability, never enumerates threads, redacts private state, and creates every replay as a separate thread. Browser roles have no table access.

Run `docs/migrations/2026-07-17-instructor-compare-history.sql` to persist completed Instructor Compare results. The bottom of that tab can then filter and reopen full historical comparisons, including model/token/timing data, citations, quality signals, caveats, and graph traces. Only the already-redacted API response is stored; private retrieval pools remain excluded and browser roles have no direct table access.

Then run `docs/migrations/2026-07-17-instructor-compare-workflows.sql` for multi-turn result indexing and the server-only branch idempotency cache. Guided comparison capabilities are signed server-side and authorize one exact thread; they do not expose the signing credential or permit thread enumeration.

Test a real process restart with `npm run test:langgraph-thread -- seed`, restart the server, then run the resume command printed by the script. See [`docs/LANGGRAPH_TEST_PLAN.md`](docs/LANGGRAPH_TEST_PLAN.md) for the complete acceptance tests.

The integration scripts target `http://localhost:3000` by default. Set `RAG_BASE_URL` when the app runs on another port, for example `RAG_BASE_URL=http://localhost:3100 npm run test:instructor-compare`.

## How The Technology Works

RAG means Retrieval-Augmented Generation:

```text
retrieve relevant source evidence -> add it to the prompt -> generate an answer grounded in that evidence
```

One-sentence explanation:

```text
ZenCub RAG is a BJJ transcript research system that searches a BJJ video knowledge base and answers questions using cited clips instead of generic model memory.
```

The app has three working layers right now:

```text
Browser UI
  -> /api/rag/search
    -> Supabase RPC: search_rag_transcript_chunks
      -> table: rag_transcript_chunks
        -> cited transcript results
```

That is the broad text-retrieval baseline. It finds source chunks and shows evidence.

Semantic search adds this layer:

```text
User question
  -> embed question
    -> vector search matching embedded transcript chunks
      -> meaning-matched transcript chunks
```

Answer generation adds this layer:

```text
User question
  -> retrieve source chunks
    -> send chunks to LLM
      -> answer with citations
```

Instructor comparison adds a multi-branch research workflow:

```text
situational question
  -> semantic + keyword + technique retrieval in parallel
    -> canonical person attribution
      -> instructor-diverse panel
        -> one independent analysis branch per instructor
          -> cross-instructor synthesis
            -> multi-instructor citation validation
```

The comparison route is `POST /api/rag/instructor-compare`. It uses only high-confidence `instructor` attributions whose canonical `rag_creators` kind is `person`; channels and publishers are not presented as instructors. The current TEST snapshot contains 1,044 videos attributed to 263 canonical people. Each run receives a new checkpoint thread and the UI exposes the graph trace, branch fan-out, checkpoint count, evidence coverage, consensus, differences, and decision guide.

Instructor Compare defaults to OpenRouter `qwen/qwen3-235b-a22b-2507`, which produced stronger validated comparison coverage than the local model in the initial live test. The selector also permits OpenAI `gpt-4o-mini` and local `qwen3.6:35b-mlx`. Local zero-paid mode deliberately disables OpenAI query embeddings and uses parallel Postgres keyword plus technique-metadata retrieval; analysis, optional reranking, and synthesis all use the local model. Remote modes enable semantic retrieval when `OPENAI_API_KEY` is available. Results report prompt, completion, and total generation tokens per model call, per-stage latency, total elapsed time, and an in-browser recent-run comparison. Embedding-token usage is not included in generation-token totals.

The important separation:

- `rag_` source tables hold the BJJ video-transcript corpus.
- `rag_transcript_chunks` holds searchable evidence chunks with timestamps.
- `embedding` holds vector representations; 12,104 chunks are embedded; the transcript corpus has full vector coverage.
- API routes own all database access so secrets stay server-side.
- `rag_search_logs` stores every user-triggered query and action type; browser clients cannot access it directly.
- `rag_followup_experiment_runs` stores only experimental LangGraph run metadata, timing, routing, and node traces; it is also server-only.
- `rag_research_notes` stores only notes that passed the LangGraph approval interrupt; `rag_langgraph_test_events` stores local recovery-test counters. Both are server-only and protected by RLS.
- `/api/rag/analyze` reruns the current search, sends the top chunks to a small/fast model, and returns a structured watch plan.
- `/api/rag/vector-search` embeds the query and calls `match_rag_transcript_chunks`.
- `/api/rag/ask` fuses vector + text retrieval with Reciprocal Rank Fusion, caps sources per video, reranks by intent, enriches with technique metadata, and returns a cited answer. Retrieval helpers live in `src/lib/ragRetrieval.ts`.

## Data Source

Supabase project: `YOUR_PROJECT_REF` (set via `NEXT_PUBLIC_SUPABASE_URL`)

Tables used:

- `rag_videos`
- `rag_video_transcripts`
- `rag_techniques`
- `rag_video_attributions`
- `rag_creators`
- `rag_transcript_chunks`
- `rag_search_logs`
- `rag_followup_experiment_runs` (optional experimental telemetry)
- `rag_research_notes` (approved LangGraph notes)
- `rag_langgraph_test_events` (test-mode recovery counters)
- `rag_langgraph_replay_threads` (test-only capability hashes and branch provenance)
- `rag_instructor_compare_runs` (server-only safe comparison results for quality review)
- `rag_instructor_compare_branch_cache` (server-only successful branch outputs for selective recovery)

Current dataset:

- `2,402` videos
- `2,298` transcripts
- `2,844` techniques
- `12,104` transcript chunks
- `12,104` embedded chunks

## Interface

The home page has five tabs:

- `Search`: live text search over transcript chunks. This tab also holds three buttons:
  - `Analyze Results`: shown after a search; summarizes the best watch moments and study takeaways from the current results.
  - `Semantic Search`: embeds the query and searches the embedded chunks by meaning.
  - `Ask`: generates an answer using retrieved chunks and citations.
  - `Ask a follow-up`: defaults to the proven Classic path. An explicit `LangGraph · Experimental` toggle runs a separate workflow that decides whether the user continued or changed topics, chooses whether to retain earlier sources, and validates returned citations.
- `System Map`: visual explanation of the RAG data flow, table roles, current state, and next steps.
- `In App Experience`: answer-first presentation using the same server-side providers.
- `Instructor Compare`: guided multi-instructor research that visibly loops on weak evidence, pauses for clip review, fans out instructor and claim checks, resumes follow-ups, selectively recovers failures, and branches controlled model experiments without changing the original thread.
- `Lang Tests`: live Classic/LangGraph comparisons, approval and recovery labs, and an authorized checkpoint timeline/replay control that labels original and branch threads separately.

Good test queries in the current text-search build:

- `knee cut`
- `saddle`
- `crossface`
- `underhook half guard`
- `guard retention`
- `heel hook escape`
- `single leg x`
- `kimura trap`
- `body lock pass`
- `deep half`
- `rear naked choke`
- `armbar`
- `triangle choke`
- `arm triangle`
- `ankle lock`
- `heel hook`
- `mount escape`
- `closed guard pass`
- `bow and arrow choke`
- `omoplata`

These are not just examples in the UI. They are evaluated through the live API:

```bash
npm run eval:queries
```

The evaluator calls `/api/rag/search`, checks that each query returns enough results, verifies expected BJJ terms appear in the retrieved evidence, and confirms top results include citations, timestamps, and source URLs.

Latest generated report:

```text
docs/evals/rag-search-eval.md
```

## Commands

```bash
npm run typecheck
npm run build
npm run eval:queries
npm run embed:chunks -- --limit=2048
npm run embed:chunks -- --limit=2048 --apply
npm run dev -- --port 3021
npm run test:langgraph-thread -- seed
npm run test:langgraph-approval -- approve
npm run test:langgraph-recovery
npm run test:langgraph-replay
npm run test:instructor-compare
```

`embed:chunks` defaults to dry-run. Use `--apply` to write vectors. Use `--all --apply` only when you intentionally want to backfill every missing chunk in TEST. `embed:chunks` requires `RAG_TEST_PROJECT_REF` to match the target Supabase host as a safety guard against writing to the wrong project.

## License

MIT — see [LICENSE](LICENSE).
