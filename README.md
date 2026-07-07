# ZenCub RAG

Separate internal RAG app for exploring ZenCub transcript search and grounded answers.

This app is intentionally separate from the main ZenCub web and iOS repos. It reads the TEST Supabase `rag_` tables created from a PROD transcript snapshot and should not write to normal ZenCub app tables.

## Current Scope

- Read-only transcript search over `rag_transcript_chunks`
- Citation-oriented results using chunk metadata
- Server-side Supabase service-role access only
- First-pass semantic search over the initial embedded chunk batch
- Generated cited answers through `/api/rag/ask`
- Home-page `System Map` tab visualizes the pipeline, current coverage, and remaining backfill work

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
RAG_ANALYZE_MODEL=gpt-4o-mini
RAG_ANSWER_MODEL=gpt-4o-mini
RAG_EMBEDDING_MODEL=text-embedding-3-small
```

The browser never receives the service-role key. API routes own all database access.

## How The Technology Works

RAG means Retrieval-Augmented Generation:

```text
retrieve relevant source evidence -> add it to the prompt -> generate an answer grounded in that evidence
```

One-sentence explanation:

```text
ZenCub RAG is a BJJ transcript research system that searches ZenCub's video knowledge base and answers questions using cited clips instead of generic model memory.
```

The app has three working layers right now:

```text
Browser UI
  -> /api/rag/search
    -> Supabase RPC: search_rag_transcript_chunks
      -> TEST table: rag_transcript_chunks
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

- `rag_` source tables hold the copied ZenCub TEST corpus.
- `rag_transcript_chunks` holds searchable evidence chunks with timestamps.
- `embedding` holds vector representations; the first 256 chunks are embedded for testing, with the full backfill still pending.
- API routes own all database access so secrets stay server-side.
- `/api/rag/analyze` reruns the current search, sends the top chunks to a small/fast model, and returns a structured watch plan.
- `/api/rag/vector-search` embeds the query and calls `match_rag_transcript_chunks`.
- `/api/rag/ask` retrieves chunks, falls back to text search when vector matches are weak, and returns a cited answer.

## Data Source

TEST Supabase project: `YOUR_PROJECT_REF`

Tables used:

- `rag_videos`
- `rag_video_transcripts`
- `rag_techniques`
- `rag_video_attributions`
- `rag_creators`
- `rag_transcript_chunks`

Current TEST snapshot:

- `2,402` videos
- `2,298` transcripts
- `2,844` techniques
- `12,104` transcript chunks
- `256` embedded chunks

## Interface

The home page has two tabs:

- `Search`: live text search over transcript chunks.
- `Analyze Results`: button shown after a search; summarizes the best watch moments and study takeaways from the current results.
- `Semantic Search`: embeds the query and searches the embedded chunk subset by meaning.
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
npm run embed:chunks -- --limit=256
npm run embed:chunks -- --limit=256 --apply
npm run dev -- --port 3021
```

`embed:chunks` defaults to dry-run. Use `--apply` to write vectors. Use `--all --apply` only when you intentionally want to backfill every missing chunk in TEST.

Local dashboard launcher:

```text
/Users/YOUR_USER/Desktop/Apps/Run_ZenCub_RAG.command
```
