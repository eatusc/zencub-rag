# Next Steps

Completed:

1. Postgres-checkpointed `followUpGraph` with durable `thread_id` conversation/source state and a restart-test script.
2. Private retrieval subgraph with parallel vector, keyword, metadata, and prior-context branches, followed by RRF fusion and reranking.
3. Interrupt-backed research-note review with approve, edit, reject, idempotent `rag_research_notes` writes, and restart-safe resume.
4. Authorized one-time reranker failure injection with same-thread recovery and database execution counters proving completed retrieval work is not repeated.
5. Capability-authorized checkpoint timelines and separate-thread replay branches that preserve the original trajectory and reuse successful checkpoint state.
6. Guided Instructor Compare workflow with a bounded evidence-repair loop, checkpointed human panel approval/edit/reject, dynamic per-instructor and per-claim verifier branches, same-thread follow-ups with evidence reuse, selective branch recovery, checkpoint-cloned model experiments, capability-scoped mutation controls, per-turn timing/tokens, and durable server-only quality history.

Next:

1. Import `ragExamples.ts` into a versioned LangSmith dataset and compare Classic, LangGraph, retrieval variants, citation validity, groundedness, latency, tokens/cost, and poisoned-document or prompt-injection trajectories. Prefer deterministic graders and pin any LLM judges.
2. Build the write-to-vault sandbox workflow described in `docs/LANGGRAPH_TEST_PLAN.md`, with deterministic filesystem/tool-call graders and bounded attack mutation.
3. Run `docs/migrations/2026-07-07-hybrid-rrf-index-cleanup.sql` in Supabase, then tune the per-video cap and RRF `k` against the evaluation baseline.
4. Add deployment config for a separate Railway service.
