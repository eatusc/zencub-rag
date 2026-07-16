# Log

## 2026-07-14

Completed the multi-provider Ask AI and conversational follow-up work. Split answer generation into server-only provider infrastructure (`src/lib/answerProviders.ts`) and client-safe provider metadata (`src/lib/providers.ts`). The Answer Engine selector now detects and displays providers in this order: local Qwen, OpenRouter Qwen3 235B A22B, Claude CLI, and OpenAI. Local Qwen availability is verified against Ollama's installed model list; remote providers are enabled only when their server-side credentials exist. The selected provider controls final-answer generation, while OpenAI embeddings and the optional reranker continue to power retrieval independently.

Added OpenRouter as a first-class provider rather than treating it as OpenAI. It uses `OPENROUTER_API_KEY`, `RAG_OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), and `RAG_OPENROUTER_MODEL` (default `qwen/qwen3-235b-a22b-2507`). The selector places **Qwen3 235B** directly after local Qwen and before Claude. API responses, the answer footer, token reporting, and search analytics identify it as `provider: openrouter` and show the exact model slug. If local Qwen fails at generation time, OpenRouter is the next fallback; OpenAI remains the fallback when OpenRouter is unavailable or fails.

Built follow-up questions under every AI answer. The UI keeps the original answer, prior questions/answers, and retained source IDs, then sends the latest follow-up back through `/api/rag/ask`. Conversation history is used for continuity but is explicitly not treated as evidence; retrieved transcript chunks remain the only source of truth. History is bounded to six turns and source IDs are bounded/deduplicated. Each answer now includes a model-generated `suggested_follow_up`, which becomes the context-specific textarea placeholder instead of a fixed knee-cut example. Follow-up answers render as a conversation with their own citations, takeaways, caveats, provider/model identity, and generation-token counts.

Added answer usage reporting. When a provider reports usage, the UI shows total generation tokens plus prompt/output counts beneath the answer. It also shows the actual provider and model, making it possible to distinguish local `qwen3.6:35b-mlx`, OpenRouter `qwen/qwen3-235b-a22b-2507`, Claude CLI, and the configured OpenAI model. Tightened the structured-answer prompt so `key_takeaways`, `follow_up_searches`, and `caveats` must be JSON arrays, addressing the schema deviation found during model evaluation.

Added persistent server-side search analytics with `src/lib/searchLogging.ts` and `docs/migrations/2026-07-14-search-logging.sql`. Keyword, semantic, Analyze Results, Ask AI, and follow-up queries are written to `public.rag_search_logs` with action, provider, retrieval mode, metadata, and timestamp. RLS is enabled; `anon` and `authenticated` have no access, while `service_role` receives only the required table/sequence privileges. The provider constraint now accepts `qwen`, `openrouter`, `claude`, and `openai`. A compatibility retry preserves the provider in metadata if app code is deployed before the matching constraint migration.

Expanded the in-app System Map below the database table map. It now lists `rag_search_logs` and includes a **Model Usage by App Action** table with an explicit **Uses LLM?** column plus Local Qwen/Claude, OpenRouter, and OpenAI columns. The table distinguishes regular search, semantic query embeddings, Analyze Results, each Ask AI answer-engine choice, follow-ups, and page-load availability probes.

Added a repeatable OpenRouter RAG evaluation harness (`scripts/evaluate-openrouter-rag.ts`, `npm run eval:openrouter`). It performs shared hybrid retrieval and OpenAI reranking, requests strict cited JSON, checks exact citation copying and follow-up generation, records latency/tokens/cost/provider, and runs a blind six-dimension BJJ judge. The first three-query comparison covered Qwen3.5 Flash, Qwen3 32B, Qwen3 30B A3B, Mistral Small 3.2, Gemini 2.5 Flash Lite, GPT-4.1 Nano, Qwen3 235B A22B, and GPT-4o Mini. A second three-query finalist run compared only Qwen3 235B and GPT-4.1 Nano on unseen mount, butterfly, and triangle scenarios.

Across the combined six-query finalist sample, Qwen3 235B averaged about 1.00s and $1.06 per 1,000 answers, generated all six follow-ups, and copied all citations exactly in 6/6 cases. GPT-4.1 Nano averaged about 330ms and $0.58 per 1,000 answers with a slightly higher mean prose score, but copied all citations exactly in only 2/6 cases. Qwen3 235B was selected for the app because citation fidelity is the higher-priority property for transcript-grounded RAG. Full reports are generated locally under `docs/evals/` (gitignored, not committed since they contain verbatim third-party transcripts).

Final verification: `npm run typecheck` passed; the standard search regression suite passed 19/19 and refreshed `docs/evals/rag-search-eval.md`; `/api/rag/providers` returned Qwen -> Qwen3 235B -> Claude -> OpenAI with all four available; and a post-migration full-stack Ask for a grapevine mount escape returned HTTP 200 through `provider: openrouter`, model `qwen/qwen3-235b-a22b-2507`, vector retrieval with reranking, eight sources, 4,905 generation tokens, two citations, structured caveats, and a relevant suggested follow-up. The same request was read back from Supabase as an `ask` row with `provider = openrouter`, confirming answer generation and persistent logging work together.

## 2026-07-07

Reviewed the live TEST database and reworked retrieval quality. Introspected all six `rag_` tables via PostgREST: confirmed counts (2,402 videos / 2,298 transcripts / 2,844 techniques / 2,385 attributions / 468 creators / 12,104 chunks, all embedded), chunk sizing (median 1,096 chars / 214 words / 76s windows with ~6-7s overlap), and found two concrete problems — top results duplicating the same video (`heel hook` returned 5 results from one video 3x; `body lock pass` 5/4 distinct) and ~419 chunks under 20 tokens / ~802 under 50 that were embedded and polluting results.

Implemented the retrieval upgrades in app code (`src/lib/ragRetrieval.ts`):

- Reciprocal Rank Fusion (`rrfFuse`, k=60) replaces the old `MIN_VECTOR_TOP_SIMILARITY = 0.5` threshold + naive interleave + citation-retry in `/api/rag/ask`. Fusion needs no absolute score cutoff, so it is robust to text-rank and cosine similarity living on different scales.
- Per-video diversity cap (`capPerVideo`, max 2 per video) so top results are varied sources, not near-duplicate clips from one upload.
- Degenerate-chunk filter (`filterDegenerate`, ~120 char / ~30 token floor) applied at read time across `/api/rag/search`, `/api/rag/vector-search`, `/api/rag/analyze`, and `/api/rag/ask`. Non-destructive; routes now over-fetch (limit x3, cap 60) so a full page survives filtering.
- LLM reranker (`rerankWithLLM`, uses `RAG_RERANK_MODEL`, default `gpt-4o-mini`, toggle `RAG_RERANK=off`) reorders the diverse candidate pool by intent before generation, falling back to input order on any error. Directly targets the documented semantic-drift-on-defensive-queries weakness.
- Technique enrichment (`enrichWithTechniques`) joins each retrieved chunk's timespan to the overlapping `rag_techniques` row and passes technique/position/difficulty/gi_nogi into the answer prompt and `formatRagSource`. Previously `rag_techniques` (2,844 rows) was unused by retrieval.

Added `docs/migrations/2026-07-07-hybrid-rrf-index-cleanup.sql` for the pieces this app cannot run over PostgREST (no DDL/DML-of-that-kind access): the HNSW `vector_cosine_ops` index (a no-op at 12k rows, needed before production scale), a GIN FTS index, an optional server-side `hybrid_search_rag_chunks` RRF function to push fusion into Postgres later, and an optional hard-delete of sub-30-token chunks. These run in the Supabase SQL editor.

Deferred small-to-big chunking: it requires re-chunking/re-ingestion owned by the upstream ingestion pipeline, not this read-only app.

Verification (against the running dev server, hot-reloaded): `npm run typecheck` clean; `npm run eval:queries` 19/19 (regenerated `docs/evals/rag-search-eval.md`); `search` for `heel hook` now caps at 2 per video and pulls in a third source with min text length 907; `ask` for `how do I stop someone from passing my guard` returned `hybrid` + `reranked` with guard-pass-prevention citations (Firas Zahabi, Danaher), and `defend leg locks safely` — the documented drift case — now returns a defense-oriented cited answer instead of attack clips.

Ran a 10-phrase sweep (paraphrase, defensive-intent, and exact-term queries) through both `/api/rag/search` and `/api/rag/ask`. All 10 Ask calls returned `hybrid` + `reranked` with 8 sources; every defensive/escape phrase returned defense/escape answers rather than attacking clips; degenerate filter held (min text length 760-1487 across all results); per-video dedup held (search results 4-5 distinct videos, never 3+ from one video). Best case for hybrid: `escape when someone is crushing me in mount` returned only 1 keyword-search result (top hit was an offensive "Armbar From Mount" clip), but Ask's vector arm recovered it into a proper mount-escape answer.

Added a citation-diversity nudge to the `/api/rag/ask` answer prompt ("prefer citing 2 or more distinct videos when multiple sources support the answer"). Note: the apparent "citations collapse to one video" signal that prompted this was mostly a measurement bug in the test harness (it split YouTube `watch_url` on `?`, collapsing every video to the shared `/watch` prefix). Re-measured by `v=` id, Ask citations were already diverse — 2 distinct videos across the re-checked queries. The prompt line is kept as harmless reinforcement, not a fix for a real collapse. Retrieval-side dedup and citation-side diversity are both healthy.

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

## 2026-07-07

Fixed the `heel hook escape` Ask failure. Root cause: vector retrieval matched back-control "hook escape" chunks with high similarity while text retrieval found leg-lock/heel-hook-adjacent evidence. Updated `/api/rag/ask` auto mode to use hybrid retrieval when vector matches are strong, text-only fallback when vector matches are weak, and a second text-only retry if generated citations are empty. Re-ran the 10-query Ask sweep: all 10 returned 200 with at least 2 citations; `heel hook escape` now falls back to text and cites `How to Build Bulletproof Defense (Without the Panic) @ 3:28`.

Added hover/focus tooltips to Search, Semantic Search, and Ask explaining keyword search vs meaning search vs generated cited answers. Updated architecture/RAG docs and next steps for hybrid retrieval.

## 2026-07-07

Researched common BJJ move/search terms from public technique/submission lists, then expanded the evaluated query bank from 9 to 19 examples. Added `rear naked choke`, `armbar`, `triangle choke`, `arm triangle`, `ankle lock`, `heel hook`, `mount escape`, `closed guard pass`, `bow and arrow choke`, and `omoplata` to `src/lib/ragExamples.ts`. Re-ran `npm run eval:queries`: 19/19 passed and regenerated `docs/evals/rag-search-eval.md/json`.

Ran normal Search vs Semantic Search comparisons for concept queries and saved findings in `docs/evals/rag-semantic-comparison.md`. Best semantic wins: `how do I stop someone passing my guard` found Danaher guard retention, `escape heavy mount pressure` avoided match-commentary drift, and `finish a choke from the back` found a focused rear-naked-choke clip. Remaining semantic weakness: some defensive/ambiguous phrasing still needs hybrid ranking/full embedding coverage.

## 2026-07-07

Ran another TEST embedding pass with `npm run embed:chunks -- --limit=4096 --apply`. It embedded 2,944 additional chunks before the next batch load hit a Supabase statement timeout. Coverage is now 7,296 embedded chunks out of 12,104; 4,808 remain missing vectors. Updated System Map, README, architecture, RAG technology notes, next steps, and semantic comparison docs with the new counts.

Hardened `scripts/embed-rag-chunks.ts` after the timeout: removed the `created_at` sort from the missing-embedding batch select and added retry/backoff for transient load timeouts. Re-ran testing after the new embeddings: `npm run eval:queries` still passed 19/19. Focused Semantic/Ask sweep for the 10 newly added common-move queries also passed 10/10 with cited Ask answers.

## 2026-07-07

Ran another TEST embedding pass with `npm run embed:chunks -- --limit=2048 --apply`. It completed cleanly, increasing coverage from 7,296 to 9,344 embedded chunks out of 12,104; 2,760 chunks remain missing vectors. Updated System Map, README, architecture, RAG technology notes, next steps, and semantic comparison docs with the new counts.

Testing after the pass: `npm run eval:queries` passed 19/19. Focused Semantic/Ask sweep for the 10 common-move queries passed 10/10 with cited Ask answers. Concept scenario sweep showed pure Semantic Search remains mixed on ambiguous defensive wording, but Ask hybrid retrieval returned cited answers for all checked scenarios.

## 2026-07-07

Completed the remaining TEST embedding backfill with `npm run embed:chunks -- --all --apply`. Embedded the final 2,760 chunks; coverage is now 12,104/12,104 with 0 missing vectors. Updated System Map, README, architecture, RAG technology notes, next steps, and semantic comparison docs to show full vector coverage.

Testing after full coverage: `npm run eval:queries` passed 19/19. Focused Semantic/Ask sweep for the 10 common-move queries passed 10/10 with cited Ask answers. Concept scenario sweep passed 8/8 for Ask citations. Pure Semantic Search still drifts on some ambiguous defensive wording, so Ask hybrid retrieval remains the safer user-facing answer path.
