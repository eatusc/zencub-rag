export {};

const baseUrl = (process.env.RAG_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const threadId = crypto.randomUUID();

const failed = await fetch(`${baseUrl}/api/rag/graph-follow-up`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    thread_id: threadId,
    query: "What should my near-side arm do against a knee cut?",
    provider: "openai",
    test_failure: "rerank_once",
    seed: {
      conversation: [{ question: "How do I stop a knee cut?", answer: "Frame and recover inside position." }],
      context_ids: [],
    },
  }),
});
const failure = await failed.json() as { error?: string; recoverable?: boolean };
if (failed.status !== 503 || !failure.recoverable) throw new Error(failure.error ?? "Expected a recoverable reranker failure.");

const resumed = await fetch(`${baseUrl}/api/rag/graph-follow-up/recover`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ thread_id: threadId }),
});
const recovery = await resumed.json() as { error?: string; status?: string; turn_index?: number; execution_counts?: Record<string, number> };
if (!resumed.ok || !recovery.execution_counts) throw new Error(recovery.error ?? "Recovery request failed.");

const counts = recovery.execution_counts;
const successfulNodes = ["vector", "keyword", "metadata", "context", "fuse"];
const passed = successfulNodes.every((node) => counts[node] === 1) && counts.rerank === 2;
if (!passed) throw new Error(`Completed work repeated: ${JSON.stringify(counts)}`);

console.log(JSON.stringify({ thread_id: threadId, status: recovery.status, turn_index: recovery.turn_index, execution_counts: counts, passed }, null, 2));
