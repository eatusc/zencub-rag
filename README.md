# ZenCub RAG

A Retrieval-Augmented Generation app that turns a BJJ (Brazilian Jiu-Jitsu) video-transcript library into a searchable, citation-backed research assistant. It runs hybrid retrieval (keyword + semantic), fuses the results, reranks them by intent, and generates answers grounded only in the retrieved source clips — every claim links back to a video and timestamp.

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
- Home-page `System Map` tab visualizes the pipeline, corpus coverage, and table roles

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

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
```

The browser never receives the service-role or model-provider keys. API routes own all database and model access.

Run `docs/migrations/2026-07-14-search-logging.sql` once in the Supabase SQL editor to create the server-only search history table. After that, keyword searches, semantic searches, analyses, Ask AI questions, and conversational follow-ups are logged automatically.

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

The important separation:

- `rag_` source tables hold the BJJ video-transcript corpus.
- `rag_transcript_chunks` holds searchable evidence chunks with timestamps.
- `embedding` holds vector representations; 12,104 chunks are embedded; the transcript corpus has full vector coverage.
- API routes own all database access so secrets stay server-side.
- `rag_search_logs` stores every user-triggered query and action type; browser clients cannot access it directly.
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

Current dataset:

- `2,402` videos
- `2,298` transcripts
- `2,844` techniques
- `12,104` transcript chunks
- `12,104` embedded chunks

## Interface

The home page has two tabs:

- `Search`: live text search over transcript chunks. This tab also holds three buttons:
  - `Analyze Results`: shown after a search; summarizes the best watch moments and study takeaways from the current results.
  - `Semantic Search`: embeds the query and searches the embedded chunks by meaning.
  - `Ask`: generates an answer using retrieved chunks and citations.
- `System Map`: visual explanation of the RAG data flow, table roles, current state, and next steps.

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
```

`embed:chunks` defaults to dry-run. Use `--apply` to write vectors. Use `--all --apply` only when you intentionally want to backfill every missing chunk in TEST. `embed:chunks` requires `RAG_TEST_PROJECT_REF` to match the target Supabase host as a safety guard against writing to the wrong project.

## License

MIT — see [LICENSE](LICENSE).
