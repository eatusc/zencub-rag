# Architecture

`zencub-rag` is a separate app that treats ZenCub TEST Supabase `rag_` tables as its retrieval corpus.

## Boundaries

- This repo owns RAG UI, RAG API routes, embedding jobs, and answer generation.
- Main ZenCub remains the source system for import/extraction/product workflows.
- The RAG app should not write to non-`rag_` tables.
- PROD data should only enter this app through deliberate snapshot/sync jobs.

## Retrieval Flow

Initial text-search flow:

1. User enters a query.
2. `/api/rag/search` calls `search_rag_transcript_chunks`.
3. API returns transcript chunks with citations and metadata.
4. UI displays source title, timestamp, platform/channel, and snippet.

Future vector RAG flow:

1. Embed transcript chunks into `rag_transcript_chunks.embedding`.
2. Embed the user query.
3. Call `match_rag_transcript_chunks`.
4. Feed retrieved chunks to the answer model.
5. Return grounded answers with citations.

## Privacy Rule

Public/global RAG can use public transcript snapshots. Private/local imports need user-scoped retrieval and must not be mixed into global retrieval.
