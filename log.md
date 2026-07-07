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

## 2026-07-07

Built `Analyze Results` as the first generated layer. Added `POST /api/rag/analyze`, which accepts a query, reruns `search_rag_transcript_chunks` server-side, trims the top 8 chunks, and asks a small/fast OpenAI chat model (`RAG_ANALYZE_MODEL`, default `gpt-4o-mini`) for strict JSON: summary, best watch moments, key details, study order, next searches, and caveats. Added the Search-tab button/panel to show timestamped watch moments and links. Did not add any security bypass; model access stays server-side through env keys. Pending: eval suite for analysis quality, embeddings, vector search, broader chat.

Verified `Analyze Results` with `knee cut`: endpoint returned 8 sources analyzed, best moments with timestamped YouTube links, key details, study order, next searches, and caveats. Tightened the prompt after first test so required arrays are populated and citations/watch URLs are copied from retrieved sources.

## 2026-07-07

Implemented first-pass embeddings and generated answers. Added `RAG_EMBEDDING_MODEL` and `RAG_ANSWER_MODEL`, `scripts/embed-rag-chunks.ts`, `GET /api/rag/vector-search`, and `POST /api/rag/ask`. The embedding script reads `.env.local`, refuses non-TEST Supabase hosts, defaults to dry-run, and writes vectors only with `--apply`. Initial batch embedded 256 of 12,104 TEST chunks with `text-embedding-3-small`; 11,848 chunks remain unembedded. First write attempt used partial upsert and failed on `video_id` not-null, so the script was fixed to use bounded concurrent row updates.

Updated the Search UI with `Semantic Search` and `Ask` buttons plus an answer panel showing answer text, takeaways, citations, follow-up searches, and caveats. `Ask` uses vector retrieval in auto mode but falls back to text retrieval when vector matches are sparse or weak, which matters while vector coverage is partial. Updated README, architecture, RAG technology notes, System Map copy, env docs, and next steps.

Verification: `npm run typecheck`, `npm run eval:queries` (9/9), `npm audit --omit=dev` (0 vulnerabilities), `npm run build`, manual `/api/rag/vector-search?q=knee%20cut&limit=3`, and manual `/api/rag/ask` for `How do I finish a knee cut pass?` with cited watch links.

## 2026-07-07

Added System Map panels explaining embedding vectors as numeric meaning fingerprints and the backfill job as text -> embedding model -> `rag_transcript_chunks.embedding`. Updated RAG technology notes with the same definition and then-current coverage: 256 embedded chunks, 11,848 remaining.

## 2026-07-07

Ran two additional bounded TEST embedding passes with `npm run embed:chunks -- --limit=2048 --apply`. Coverage increased from 256 to 4,352 embedded chunks out of 12,104; 7,752 chunks remain missing vectors. Updated System Map, README, architecture, RAG technology notes, and next steps to reflect the new counts.

Re-ran the 10-query semantic/Ask sweep after the backfill. All 10 vector searches returned 200 with 3 results and all 10 Ask calls returned 200. Ask used vector retrieval for `knee cut`, `underhook half guard`, `guard retention`, `single leg x`, `body lock pass`, and `heel hook escape`; it used text fallback for `saddle`, `crossface`, `kimura trap`, and `deep half`. Remaining issue: `heel hook escape` still returned 0 citations despite vector retrieval, so Ask needs a hybrid retrieval/citation guard before relying on vector-only answers broadly.
