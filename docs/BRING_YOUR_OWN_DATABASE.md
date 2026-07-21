# Bring Your Own Database

ZenCub RAG does not require access to the author's Supabase project. Each user
should create a separate Supabase project, load a corpus they are authorized to
use, and keep its credentials only in that deployment's server environment.

## 1. Create a Supabase project

Create a new project in Supabase, record its project reference, and collect:

- the project URL
- the anon key (required by the current environment contract, but not used for
  direct corpus access)
- the service-role key, which must remain server-only
- a direct or pooler Postgres connection string for LangGraph checkpoints

Never commit these values. Put them in `.env.local`, which this repository
ignores. A public Git repository does not make a deployment private: the API is
private only when network access or authentication restricts who can reach it.

## 2. Create the core corpus schema

In the new project's Supabase SQL editor, run:

```text
docs/migrations/2026-07-17-rag-core-bootstrap.sql
```

This creates the six core `rag_*` tables, enables pgvector, creates keyword and
vector retrieval RPCs, enables RLS, and removes browser-role access. It creates
an empty database; it does not copy ZenCub data or third-party transcripts.

The embedding column is `vector(1536)`, matching the default
`text-embedding-3-small` model. If you intentionally select an embedding model
with another dimension, change the column and RPC parameter dimensions before
loading embeddings.

## 3. Load your authorized corpus

Ingest records in this order:

1. `rag_videos`
2. `rag_video_transcripts`
3. `rag_transcript_chunks`
4. `rag_techniques` (optional for basic search, recommended for metadata retrieval)
5. `rag_creators` and `rag_video_attributions` (required for Instructor Compare)

Video downloading, speech-to-text, transcript chunking, and technique extraction
belong to an upstream ingestion pipeline and are intentionally outside this
repository. You may import CSV/JSON through Supabase or write your own ingestion
job using the service role. Only load videos and transcripts you have permission
to process and redistribute.

A minimal chunk looks like:

```json
{
  "video_id": "my-video-001",
  "chunk_index": 0,
  "start_seconds": 0,
  "end_seconds": 75,
  "text": "Your timestamped transcript passage...",
  "token_count": 120,
  "metadata": {
    "video_title": "My instructional video",
    "video_url": "https://www.youtube.com/watch?v=...",
    "platform": "youtube",
    "channel_name": "Example instructor",
    "instructor_name": "Example instructor",
    "thumbnail_url": "https://...",
    "slug": "my-instructional-video",
    "citation": "My instructional video @ 0:00"
  }
}
```

`rag_video_transcripts.segments` should be a JSON array of caption objects with
`text` and either `start` or `offset`, plus `duration` or `end`. The app uses
these segments only to refine coarse chunk timestamps.

For Instructor Compare, `rag_video_attributions.video_id` references the UUID
`rag_videos.id`, not the external text `rag_videos.video_id`. Attribution rows
must use `role = 'instructor'`, confidence at least `0.7`, and a creator whose
effective `kind_override`/`kind` is `person`.

## 4. Configure the app

Copy `.env.example` to `.env.local` and set your own values:

```bash
cp .env.example .env.local
```

At minimum, configure:

```text
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
RAG_TEST_PROJECT_REF=YOUR_PROJECT_REF
OPENAI_API_KEY=YOUR_KEY
OPENROUTER_API_KEY=YOUR_KEY
LANGGRAPH_DATABASE_URL=YOUR_SERVER_ONLY_POSTGRES_URL
LANGGRAPH_CHECKPOINT_SCHEMA=langgraph
LANGGRAPH_TEST_MODE=off
```

OpenAI is currently used for query embeddings in semantic/hybrid retrieval.
OpenRouter is required for the default Qwen3 235B Instructor Compare model.
Local Qwen remains available when its configured Ollama-compatible endpoint is
running. Provider keys and the database connection string must never use a
`NEXT_PUBLIC_` prefix.

## 5. Generate embeddings

Preview the embedding backfill first:

```bash
npm run embed:chunks -- --limit=100
```

After confirming that `RAG_TEST_PROJECT_REF` matches your project, write a
bounded batch:

```bash
npm run embed:chunks -- --limit=100 --apply
```

Repeat with larger bounded batches as appropriate. The script only processes
chunks whose `embedding` is null. Keyword search works before embeddings are
created; semantic search does not.

## 6. Add optional application and LangGraph tables

Run only the features you intend to use, in this order:

```text
docs/migrations/2026-07-14-search-logging.sql
docs/migrations/2026-07-15-followup-experiments.sql
docs/migrations/2026-07-17-langgraph-persistence.sql
docs/migrations/2026-07-17-langgraph-approval-recovery.sql
docs/migrations/2026-07-17-langgraph-checkpoint-replay.sql
docs/migrations/2026-07-17-instructor-compare-history.sql
docs/migrations/2026-07-17-instructor-compare-workflows.sql
```

Then initialize the LangGraph checkpointer:

```bash
npm run langgraph:setup
```

Leave `LANGGRAPH_TEST_MODE=off` for normal/private use. Turn it on only while
intentionally running note-write, failure-recovery, or checkpoint-replay labs.

## 7. Verify the installation

Start the app and check the empty/loaded corpus:

```bash
npm run dev
curl http://localhost:3000/api/health
```

Then run:

```bash
npm run typecheck
npm run eval:queries
npm run test:instructor-compare
npm run test:instructor-compare-workflow
```

The bundled query evaluator is BJJ-specific and will fail against a different
domain until you replace `src/lib/ragExamples.ts` with examples appropriate to
your own corpus. The health endpoint and direct Search tab are the correct first
checks for any domain.

The current System Map and Instructor Compare introduction also contain
ZenCub-snapshot counts and BJJ wording. When publishing a fork with another
corpus, update the display constants in `src/components/SearchClient.tsx` and
`src/components/InstructorCompare.tsx`; these labels do not control retrieval.
