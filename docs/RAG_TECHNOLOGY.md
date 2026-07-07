# RAG Technology

RAG means Retrieval-Augmented Generation. The model does not answer from memory alone. The app first retrieves relevant source material, puts that material into the model prompt, and asks the model to answer from that evidence.

Short version:

```text
retrieve evidence -> augment the prompt -> generate a grounded answer
```

How to explain this app:

```text
ZenCub RAG turns ZenCub's BJJ transcript library into a searchable research assistant. It finds source clips, uses transcript chunks as evidence, and generates cited answers instead of relying on generic model memory.
```

## What People Use RAG For

RAG is useful when the answer needs to come from a specific corpus, not generic model memory.

Common uses:

- customer-support bots grounded in a company's help docs
- internal company knowledge search
- legal or medical document review with citations
- product documentation assistants
- research assistants over papers, notes, and transcripts
- training/tutoring systems for a specialized domain
- private library search where the model should not invent sources

## Current App

The current app has three layers.

Text retrieval:

```text
User query
  -> /api/rag/search
    -> Postgres full-text search
      -> rag_transcript_chunks
        -> transcript snippets with citations
```

Semantic retrieval:

```text
User query
  -> /api/rag/vector-search
    -> OpenAI embedding
      -> match_rag_transcript_chunks
        -> meaning-ranked transcript snippets
```

Generated answers:

```text
User query
  -> /api/rag/ask
    -> retrieve source chunks
      -> answer model
        -> answer, citations, takeaways, follow-up searches, caveats
```

The generated answer layer is full RAG: it retrieves external corpus evidence, augments the model prompt with that evidence, and asks the model to answer from the retrieved sources.

## Full RAG Target

```text
Transcript chunks
  -> embedding job
    -> vectors in rag_transcript_chunks.embedding

User question
  -> question embedding
    -> vector similarity search
      -> top transcript chunks
        -> LLM prompt
          -> cited answer
```

This target is implemented as a first pass. TEST currently has full vector coverage: 12,104 embedded chunks out of 12,104 total chunks.

## Why Chunks Exist

The raw transcript table stores full transcript segment arrays. That is too large and too noisy to pass directly to an LLM.

`rag_transcript_chunks` groups nearby transcript segments into timestamped blocks. Each chunk is small enough to search, cite, embed, and include in an answer prompt.

## Why Embeddings Matter

Text search finds matching words. Vector search finds matching meaning.

An embedding vector is a numeric representation of a transcript chunk. The model turns text into a long list of numbers, and chunks with similar meaning end up close together in vector search.

Example:

```text
Query: how do I stop someone turning into me after a pass?
```

Text search may miss good clips if the transcript says "crossface", "underhook", or "pin the shoulders" instead. Embeddings make those conceptually related chunks retrievable.

The backfill process reads `rag_transcript_chunks.text`, sends each chunk to the embedding model, then writes the returned vector into `rag_transcript_chunks.embedding` with `embedded_at` and `embedding_model`. TEST currently has 12,104 embedded chunks and 0 chunks missing vectors.

## Good Queries To Test

These are good for the current text-search and Ask flows:

| Query | Why it is useful |
| --- | --- |
| `knee cut` | Basic word match; should return clips about knee-cut passing details. |
| `saddle` | Leg-lock position search; good for testing short topical queries. |
| `crossface` | Pinning/control concept that appears across multiple passing contexts. |
| `underhook half guard` | Multi-term BJJ concept; useful for seeing ranking quality. |
| `guard retention` | Broad concept query with many possible source videos. |
| `heel hook escape` | Submission-defense query; useful once embeddings are added. |
| `single leg x` | Position-specific query; tests transcript spelling and phrasing. |
| `kimura trap` | Named technique system; should surface focused clips if present. |
| `rear naked choke` | Common back submission; tests choke/back-control evidence. |
| `armbar` | Common joint lock; tests short named-technique matching. |
| `triangle choke` | Common guard submission; tests setup/escape evidence. |
| `arm triangle` | Head-and-arm choke; tests multi-word submission matching. |
| `ankle lock` | Leg-lock query; tests straight-foot-lock/ankle-lock evidence. |
| `heel hook` | Leg-lock query; tests heel-exposure and leg-entanglement evidence. |
| `mount escape` | Common beginner problem; tests escape/recovery evidence. |
| `closed guard pass` | Common passing problem; tests guard-opening and passing evidence. |
| `bow and arrow choke` | Gi back submission; tests lapel choke evidence. |
| `omoplata` | Shoulder-lock guard attack; tests less common named-technique evidence. |

## Why Citations Matter

Every useful answer should point back to the source chunk:

```text
How To Actually Use Your Crossface @ 0:00
```

That lets you inspect whether the answer is grounded in the right BJJ evidence.

## Current vs Pending

Current:

- TEST `rag_` snapshot tables
- `12,104` transcript chunks
- text-search endpoint
- Analyze Results endpoint for grounded watch-plan summaries
- embedding script with TEST-project guard
- `12,104` embedded chunks for semantic-search validation
- vector search endpoint
- Ask endpoint for generated cited answers
- visual search UI
- System Map tab
- evaluated example-query suite

Pending:

- answer-quality evaluation
- vector-search evaluation set
- deployment config for a separate hosted service

## Analyze Results

`Analyze Results` is the first generated layer.

It is narrower than open-ended chat:

```text
current query
  -> rerun top search results on the server
    -> summarize the most useful watch moments
      -> show timestamped sources, key details, study order, and next searches
```

This is useful before full chat because it keeps the model grounded in visible retrieved evidence.

## Ask

`Ask` is the open-ended RAG answer path.

```text
current query
  -> retrieve vector + text candidate pools
    -> drop degenerate chunks, fuse with Reciprocal Rank Fusion
      -> cap to 2 chunks per video, then LLM-rerank by intent
        -> enrich top chunks with overlapping technique metadata
          -> answer from retrieved source chunks only
```

It returns a compact answer, citations with watch links, key takeaways, follow-up searches, and caveats. RRF fusion removes the need for a similarity threshold, the per-video cap keeps sources diverse, and the reranker fixes intent mismatches (for example, a "defend leg locks" query surfacing defensive rather than attacking clips).

## Evaluation System

The first evaluation suite tests retrieval quality, not generated answers.

It runs 19 practical BJJ queries through `/api/rag/search`:

- `knee cut`
- `saddle`
- `crossface`
- `underhook half guard`
- `guard retention`
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

For each query, it checks:

- at least 3 results returned
- expected BJJ terms appear in the retrieved evidence
- top results include citations and timestamps
- top results include source video URLs

Run it with:

```bash
npm run eval:queries
```

Report:

```text
docs/evals/rag-search-eval.md
```

Manual API checks currently cover:

- `/api/rag/vector-search?q=knee%20cut&limit=3`
- `/api/rag/ask` with `How do I finish a knee cut pass?`

Automated evals for vector retrieval and generated answer quality are still pending.
