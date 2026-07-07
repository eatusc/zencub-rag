# Architecture

`zencub-rag` is a separate app that treats ZenCub TEST Supabase `rag_` tables as its retrieval corpus.

## Boundaries

- This repo owns RAG UI, RAG API routes, embedding jobs, and answer generation.
- Main ZenCub remains the source system for import/extraction/product workflows.
- The RAG app should not write to non-`rag_` tables.
- PROD data should only enter this app through deliberate snapshot/sync jobs.

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

Future vector RAG flow:

```text
Ask tab
  -> embed user question
    -> rpc("match_rag_transcript_chunks")
      -> top semantic chunks
        -> answer model prompt
          -> cited answer
```

1. Embed transcript chunks into `rag_transcript_chunks.embedding`.
2. Embed the user query.
3. Call `match_rag_transcript_chunks`.
4. Feed retrieved chunks to the answer model.
5. Return grounded answers with citations.

## Visual Map In The App

The home page has two tabs:

- `Search`: the working retrieval surface.
- `System Map`: a visual chart of source snapshot -> chunks -> retrieval -> embeddings -> generated answers.

The System Map intentionally marks embeddings and generated answers as pending because the current app does not yet write vectors or call an LLM to compose answers.

It also includes:

- a plain-English RAG definition
- common RAG use cases
- clickable test queries that run against `/api/rag/search`
- table roles for each `rag_` table

## Example Evaluation

The evaluated examples live in `src/lib/ragExamples.ts`. The UI imports the same list that the evaluator uses, so displayed examples and test cases cannot drift.

Run:

```bash
npm run eval:queries
```

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

## Privacy Rule

Public/global RAG can use public transcript snapshots. Private/local imports need user-scoped retrieval and must not be mixed into global retrieval.
