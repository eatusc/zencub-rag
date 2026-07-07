# Next Steps

1. Add an automated evaluation suite for `/api/rag/ask` answer quality, citation validity, and caveat behavior — and measure the RRF + rerank pipeline against the pre-change baseline.
2. Add a vector-search evaluation set so semantic retrieval quality can be measured separately from text search.
3. Run `docs/migrations/2026-07-07-hybrid-rrf-index-cleanup.sql` in Supabase: add the HNSW/GIN indexes, and optionally move RRF fusion into the `hybrid_search_rag_chunks` function so `/api/rag/ask` can drop its two-call app-side fusion.
4. Tune the per-video cap and RRF `k` once answer-quality evals exist; consider MMR with candidate embeddings instead of the flat per-video cap.
5. Add deployment config for a separate Railway service.
