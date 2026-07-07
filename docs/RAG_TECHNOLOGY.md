# RAG Technology

RAG means Retrieval-Augmented Generation. The model does not answer from memory alone. The app first retrieves relevant source material, puts that material into the model prompt, and asks the model to answer from that evidence.

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
