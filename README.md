# ZenCub RAG

Separate internal RAG app for exploring ZenCub transcript search and grounded answers.

This app is intentionally separate from the main ZenCub web and iOS repos. It reads the TEST Supabase `rag_` tables created from a PROD transcript snapshot and should not write to normal ZenCub app tables.

## Current Scope

- Read-only transcript search over `rag_transcript_chunks`
- Citation-oriented results using chunk metadata
- Server-side Supabase service-role access only
- No embeddings or generated answers yet
- Home-page `System Map` tab visualizes the current pipeline and pending RAG layers

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
```

The browser never receives the service-role key. API routes own all database access.

## How The Technology Works

RAG means Retrieval-Augmented Generation:

```text
retrieve relevant source evidence -> add it to the prompt -> generate an answer grounded in that evidence
```

One-sentence explanation:

```text
ZenCub RAG is a BJJ transcript research system that searches ZenCub's video knowledge base and, once answer generation is added, will answer questions using cited clips instead of generic model memory.
```

The app has two layers right now:

```text
Browser UI
  -> /api/rag/search
    -> Supabase RPC: search_rag_transcript_chunks
      -> TEST table: rag_transcript_chunks
        -> cited transcript results
```

That is retrieval, but not full generated-answer RAG yet. It finds source chunks and shows evidence.

Full RAG will add this layer:

```text
User question
  -> embed question
    -> vector search matching embedded transcript chunks
      -> send retrieved chunks to LLM
        -> answer with citations
```

The important separation:

- `rag_` source tables hold the copied ZenCub TEST corpus.
- `rag_transcript_chunks` holds searchable evidence chunks with timestamps.
- `embedding` is currently empty and will hold vector representations later.
- API routes own all database access so secrets stay server-side.

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

## Interface

The home page has two tabs:

- `Search`: live text search over transcript chunks.
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

## Commands

```bash
npm run typecheck
npm run build
npm run dev -- --port 3021
```

Local dashboard launcher:

```text
/Users/YOUR_USER/Desktop/Apps/Run_ZenCub_RAG.command
```
