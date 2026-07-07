# Log

## 2026-07-07

Created separate `zencub-rag` Next/TypeScript app. Added server-side Supabase wiring, read-only text-search API over TEST `rag_transcript_chunks`, compact search UI, README, architecture notes, and local setup docs. Embeddings and answer generation are pending.

## 2026-07-07

Added local Apps dashboard launcher `Run_ZenCub_RAG.command` on unique port `3021` and updated setup docs to match the dashboard-managed port.

## 2026-07-07

Added a home-page `System Map` tab with a visual RAG pipeline, corpus metrics, table map, and current-vs-next status. Expanded README and architecture docs, plus added `docs/RAG_TECHNOLOGY.md` for the plain-English RAG mental model.

## 2026-07-07

Expanded the System Map with a plain-English RAG definition, common RAG use cases, and clickable test queries. Mirrored the explanation and query bank in README/architecture/RAG docs.

## 2026-07-07

Added shared evaluated examples and `npm run eval:queries`, which runs 9 BJJ queries through `/api/rag/search` and verifies result count, expected terms, citations, timestamps, and source URLs. Generated `docs/evals/rag-search-eval.md` and JSON report.
