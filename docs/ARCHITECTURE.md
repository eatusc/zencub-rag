# Architecture

`zencub-rag` is a standalone RAG app that treats a Supabase `rag_` table set of BJJ video-transcript data as its retrieval corpus.

## Boundaries

- This repo owns the RAG UI, RAG API routes, embedding jobs, and answer generation.
- Transcript ingestion, transcription, and technique extraction happen in an upstream pipeline, outside this repo.
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
    -> contextualize: rewrite the follow-up and classify same topic vs new topic
      -> retrieve: retain prior sources only for the same topic, then run shared hybrid RAG
        -> rerank by intent
          -> enrich timestamps and technique metadata
            -> generate with the currently selected answer provider
              -> validate citations against retrieved sources
                -> return answer + node trace
```

This path is deliberately separate from `/api/rag/ask`. Classic remains the default. Both paths use the shared primitives in `src/lib/ragPipeline.ts`, so retrieval math cannot silently drift. The graph supports all answer providers and server-side fallback, but adds topic routing and citation validation. `rag_followup_experiment_runs` stores server-only evaluation telemetry after `docs/migrations/2026-07-15-followup-experiments.sql` is installed; missing telemetry never blocks a user answer.

## Visual Map In The App

The home page has two tabs:

- `Search`: text search, semantic search, Analyze Results, and Ask.
- `System Map`: a visual chart of source snapshot -> chunks -> retrieval -> embeddings -> generated answers.

The System Map shows embeddings and generated answers as live, with the embedded count showing current partial vector coverage.

It also includes:

- a plain-English RAG definition
- common RAG use cases
- clickable test queries that run against `/api/rag/search`
- table roles for each `rag_` table
- current embedding coverage

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

## Privacy Rule

Public/global RAG can use public transcript snapshots. Private/local imports need user-scoped retrieval and must not be mixed into global retrieval.
