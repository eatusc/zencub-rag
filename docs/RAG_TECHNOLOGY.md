# RAG Technology

RAG means Retrieval-Augmented Generation. The model does not answer from memory alone. The app first retrieves relevant source material, puts that material into the model prompt, and asks the model to answer from that evidence.

Short version:

```text
retrieve evidence -> augment the prompt -> generate a grounded answer
```

How to explain this app:

```text
ZenCub RAG turns ZenCub's BJJ transcript library into a searchable research assistant. It finds the source clips behind an answer and will eventually generate cited explanations from those clips.
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

The current app is the retrieval foundation:

```text
User query
  -> /api/rag/search
    -> Postgres full-text search
      -> rag_transcript_chunks
        -> transcript snippets with citations
```

This is not full RAG yet because it does not generate an answer. It retrieves evidence.

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

## Why Chunks Exist

The raw transcript table stores full transcript segment arrays. That is too large and too noisy to pass directly to an LLM.

`rag_transcript_chunks` groups nearby transcript segments into timestamped blocks. Each chunk is small enough to search, cite, embed, and include in an answer prompt.

## Why Embeddings Matter

Text search finds matching words. Vector search finds matching meaning.

Example:

```text
Query: how do I stop someone turning into me after a pass?
```

Text search may miss good clips if the transcript says "crossface", "underhook", or "pin the shoulders" instead. Embeddings make those conceptually related chunks retrievable.

## Good Queries To Test

These are good for the current text-search version:

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
- visual search UI
- System Map tab

Pending:

- embedding backfill
- vector search endpoint
- chat/ask endpoint
- answer generation with citations
- evaluation set for answer quality
