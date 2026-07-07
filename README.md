# ZenCub RAG

Separate internal RAG app for exploring ZenCub transcript search and grounded answers.

This app is intentionally separate from the main ZenCub web and iOS repos. It reads the TEST Supabase `rag_` tables created from a PROD transcript snapshot and should not write to normal ZenCub app tables.

## Current Scope

- Read-only transcript search over `rag_transcript_chunks`
- Citation-oriented results using chunk metadata
- Server-side Supabase service-role access only
- No embeddings or generated answers yet

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

## Commands

```bash
npm run typecheck
npm run build
npm run dev
```
