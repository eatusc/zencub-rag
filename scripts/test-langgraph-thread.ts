import { randomUUID } from "node:crypto";

const baseUrl = (process.env.RAG_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const threadId = process.env.LANGGRAPH_TEST_THREAD_ID ?? randomUUID();
const step = process.argv[2] ?? "seed";

const seed = {
  conversation: [{
    question: "How do I stop a knee cut after they get the crossface?",
    answer: "Frame, recover inside position, and prevent the passer from settling chest-to-chest.",
  }],
  context_ids: [],
};

const query = step === "seed"
  ? "What should I do with my near-side arm?"
  : "What was the passing problem from the previous turn?";

const response = await fetch(`${baseUrl}/api/rag/graph-follow-up`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    thread_id: threadId,
    query,
    provider: "openai",
    ...(step === "seed" ? { seed } : {}),
  }),
});
const payload = await response.json() as {
  error?: string;
  turn_index?: number;
  answer?: { answer?: string };
  trace?: Array<{ node: string; detail: string }>;
};

if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);

console.log(JSON.stringify({
  thread_id: threadId,
  step,
  turn_index: payload.turn_index,
  answer: payload.answer?.answer,
  restored: payload.trace?.find((entry) => entry.node === "turn_start")?.detail,
}, null, 2));

if (step === "seed") {
  console.log(`Restart the server, then run: LANGGRAPH_TEST_THREAD_ID=${threadId} npm run test:langgraph-thread -- resume`);
}
