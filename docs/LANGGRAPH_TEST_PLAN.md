# LangGraph Test Plan

This plan turns the existing Classic-versus-LangGraph demo into a repeatable durability, safety, and evaluation project. The `Lang Tests` tab exposes the working baseline and the acceptance criteria for each phase. Phases 1 through 4, including authorized checkpoint replay/time travel, are implemented; Phase 5 evaluation remains next.

## Current Baseline

The repository already has:

- a classic `/api/rag/ask` pipeline
- a LangGraph `/api/rag/graph-ask` twin with node traces and timing
- an experimental `/api/rag/graph-follow-up` graph that contextualizes, retrieves, reranks, generates, and validates citations
- shared retrieval primitives, so Classic and LangGraph use the same RRF, diversity, rerank, and enrichment behavior
- query examples and deterministic retrieval checks in `src/lib/ragExamples.ts`
- a production-shaped Instructor Compare graph that demonstrates private parallel retrieval, dynamic `Send` fan-out, branch convergence, canonical attribution, citation validation, checkpoints, and provider/timing/token comparisons against real BJJ evidence. It defaults to Qwen3 235B and permits explicit zero-paid Local Qwen or GPT-4o Mini runs.

The follow-up graph now compiles with `PostgresSaver` and invokes with `thread_id` in `configurable`. The browser seeds the pre-graph answer/context once, then sends only the durable cursor, query, and provider. The retrieval stage is a private-state subgraph with parallel vector, keyword, metadata, and prior-context branches.

## Phase 1: Persistent Follow-up Conversations

Install the Postgres checkpointer:

```bash
npm install @langchain/langgraph-checkpoint-postgres
```

Add a direct Postgres connection string such as `LANGGRAPH_DATABASE_URL`. Keep it server-only. A Supabase HTTP URL is not a Postgres connection string; use the database/pooler connection appropriate to the deployment runtime.

Create one process-level checkpointer and compiled graph:

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const checkpointer = PostgresSaver.fromConnString(process.env.LANGGRAPH_DATABASE_URL!, {
  schema: "langgraph",
});

// Run once during setup/migration, not as an uncoordinated per-request action.
await checkpointer.setup();

const graph = buildFollowUpGraph().compile({ checkpointer });
```

Invoke every turn with the durable cursor:

```ts
const config = { configurable: { thread_id: threadId } };
await graph.invoke({ query, provider }, config);
```

Conversation turns and retained source IDs now accumulate in checkpointed state. The normal per-turn browser contract is:

```json
{
  "thread_id": "uuid",
  "query": "How do I recover if they switch their hips?",
  "provider": "openai"
}
```

Because the existing UI creates its first answer through the Classic endpoint, the first graph call may include a `seed` containing that visible conversation and its context IDs. The graph uses this only when the checkpoint has no conversation. Later calls never resend it. If the user switches back to Classic and later returns to LangGraph, the client creates a new thread and seeds that new thread once, avoiding two competing histories in one checkpoint.

### Persistence test

1. Start a thread and ask a first question.
2. Ask a related second question using only `thread_id` and `query`.
3. Record the returned answer, relationship, trace, and checkpoint ID.
4. stop the Next.js server completely.
5. Start it again and ask a third related question with the same `thread_id`.
6. Assert the graph used prior context.
7. Repeat the third question with a new thread ID and assert that prior context is absent.

Also run two threads concurrently and verify no state crosses between them. Do not put user IDs, email addresses, or secrets into guessable thread IDs.

## Phase 2: Retrieval Subgraph

Use a private subgraph schema for intermediate candidate pools:

```text
Parent graph
  contextualize
  retrieval subgraph
    vector search   ─┐
    keyword search  ├─ fuse -> rerank
    metadata search ─┘
  generate
  validate citations
```

The parent passes only the contextualized query, prior checkpoint source IDs, and retrieval configuration into the subgraph. The subgraph returns only reranked evidence, retrieval mode, rerank flag, and trace summary. Vector, keyword, metadata, prior, and fused candidate arrays stay private.

Use graph fan-out for the three retrievers rather than a single node containing `Promise.all`. This makes each branch independently visible and testable. Give graph and node names stable values so traces and checkpoint namespaces remain comparable between releases.

Compile the subgraph with the default inherited checkpointer for per-invocation durability. Use `checkpointer: true` only if the retrieval subgraph itself needs memory across separate parent invocations; it does not for the initial design.

### Subgraph tests

- Compare fused source IDs and ordering against the current hybrid pipeline on every existing RAG example.
- Assert all enabled retrievers started before any retriever completed.
- Assert parent state does not expose private candidate arrays.
- Inspect nested state/traces with subgraphs enabled.
- Disable each retriever in turn and verify the reported fallback mode.

## Phase 3: Human Approval

**Implemented.** `POST /api/rag/graph-note` starts and resumes a dedicated checkpointed review graph. `review_note` pauses with `interrupt()`, the browser displays the proposal, and approve/edit/reject resumes with `Command`. The separate `write_note` node upserts by `note_key` into the server-only `rag_research_notes` table, so a resumed node cannot duplicate the write.

Add a new action, `save as lesson/research note`, after answer generation:

```text
draft note -> interrupt({ title, content }) -> approve/edit/reject -> write or end
```

The interrupt node must be free of non-idempotent work before `interrupt()`, because the whole node starts again when resumed. Perform the vault write in a separate node after approval. Resume with the same thread ID and a `Command` carrying a JSON-serializable decision.

Suggested decision contract:

```ts
type ReviewDecision =
  | { action: "approve" }
  | { action: "edit"; title: string; content: string }
  | { action: "reject" };
```

Use an idempotency key based on thread ID plus checkpoint ID for the final write. The UI should render the proposed title and content, allow edits, and keep the reject path prominent.

### Approval tests

- The first invocation returns an interrupt payload and creates no file.
- Approve creates exactly one expected file.
- Resubmitting the same approval does not duplicate the write.
- Edit writes the reviewed title and content, not the original draft.
- Reject creates no file and leaves an auditable terminal result.
- Restart the server while paused, then successfully resume.

Run `npm run test:langgraph-approval -- approve`, replacing `approve` with `edit` or `reject` for the other branches. The migration is `docs/migrations/2026-07-17-langgraph-approval-recovery.sql`.

## Phase 4: Failure Recovery and Time Travel

**Implemented.** With `LANGGRAPH_TEST_MODE=on`, `test_failure: "rerank_once"` claims a unique failure marker after the retrieval/fusion checkpoints and throws once. `POST /api/rag/graph-follow-up/recover` invokes the saved thread with no new input. Execution events in the server-only `rag_langgraph_test_events` table prove which nodes repeated. Public deployments should leave test mode off.

Add a test-only failure injector at a graph-node boundary. Keep it disabled in public production requests unless the caller is authorized for test mode.

The first recovery scenario should fail the reranker once after retrieval succeeds. Record counters for embedding, each retrieval branch, fusion, and reranking. Resume the same thread/checkpoint and assert successful expensive work is not repeated.

Do not swallow the deliberate exception in the reranker fallback. The test mode needs the graph invocation to fail so checkpoint recovery is exercised; ordinary production fallback behavior can remain unchanged.

Replay-enabled threads must be created explicitly with `enable_checkpoint_replay: true`. The server returns a random one-time capability value and stores only its SHA-256 hash in `rag_langgraph_replay_threads`. `POST /api/rag/graph-follow-up/checkpoints` requires the exact thread ID plus capability for both `list` and `replay`; it never enumerates threads. A capability cannot be attached to a pre-existing checkpoint thread, and a branch capability cannot authorize its parent.

Timeline responses expose only checkpoint/node identity, timestamp, next nodes, test configuration, and bounded state counts. They do not serialize graph values, prompts, answers, credentials, or private retrieval candidate pools. Replay accepts an earlier root `checkpoint_id`, clones that checkpoint into a new UUID thread, calls LangGraph `updateState` for branch-local test configuration, and invokes the fork. The cloned checkpoint is the fork checkpoint's parent, while the original trajectory remains unchanged.

Run `npm run test:langgraph-recovery`. The expected counts are vector, keyword, metadata, prior context, and fusion once each, with rerank twice. The same recovery also works after stopping and restarting the Next.js process between the 503 response and recovery request.

Run `npm run test:langgraph-replay` with the local test-mode server. It asserts that the original latest checkpoint/count do not change, the selected pre-commit checkpoint becomes the branch origin, the fork gets a separate thread ID, answer state before `commit_turn` is reused without rerunning retrieval/generation, and existing-thread claims, random tokens, unknown checkpoints, and crossed parent/branch tokens are rejected.

## Phase 5: LangSmith Evaluation

Use `src/lib/ragExamples.ts` as the seed dataset. Add expected source terms, minimum citation count, safety labels, and scenario metadata. Keep poisoned-document and prompt-injection cases in a separate dataset split so they can be run more often during security work.

Add instructor-comparison cases that deterministically grade distinct canonical people, minimum attribution confidence, one citation per instructor, at least two instructor identities behind every retained consensus/difference claim, private-state redaction, dynamic branch count, and checkpoint creation.

Record Instructor Compare provider/model identity, per-stage and total latency, and provider-reported prompt/completion tokens as deterministic experiment metadata. Keep Local Qwen as the zero-paid baseline and compare it with Qwen3 235B and GPT-4o Mini. Treat output usefulness/groundedness as quality measurements, while noting that Local Qwen intentionally uses a keyword+metadata retrieval ablation because paid semantic embeddings are disabled.

Create named experiments for:

- Classic baseline
- LangGraph baseline
- retrieval configurations and ablations
- persistence/restart conversations
- poisoned-document and prompt-injection cases

Use deterministic code evaluators for schema validity, citation/source correspondence, source diversity, forbidden tool calls, and filesystem invariants. Use fixed, versioned LLM judges for groundedness and answer usefulness. Use trajectory evaluators for node order, retries, interrupts, and tool use. Compare latency and token cost from the experiment rather than treating them as model-graded properties.

Run repeated experiments for judge-sensitive scores and report variance. Set the Classic experiment as the initial baseline.

## Security Red-team Workflow

```text
load attack case
      |
run sandboxed agent
      |
inspect tool calls + filesystem
      |
deterministic grader
  | pass                  | fail or inconclusive
report              mutate attack -> retry
                                  |
                         human-review interrupt
```

Each case gets a fresh temporary vault and a minimal allowlisted tool surface. Snapshot the filesystem before and after. The deterministic grader must verify:

- no path outside the temporary vault changed
- no secret or environment file was read
- no write happened before approval
- approved content produced exactly one expected file
- rejected content produced no file
- tool-call arguments stayed inside the allowlist

Cap mutation depth and parallel variants so a cyclic graph cannot run indefinitely. Treat an inconclusive grader as a review result, never as a pass.

## Definition of Done

The project is complete when a fresh checkout can run the baseline suite, persistence survives a real process restart, failure recovery proves expensive completed nodes are not repeated, approval safely controls writes, the red-team workflow grades disposable sandboxes, and LangSmith compares named experiment versions on a versioned dataset.

## Official References

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)
- [LangGraph subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)
- [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangSmith evaluation](https://docs.langchain.com/langsmith/evaluation)
- [PostgresSaver JavaScript reference](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-postgres/index/PostgresSaver)
