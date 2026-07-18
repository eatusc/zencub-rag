const baseUrl = (process.env.RAG_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const originalThreadId = crypto.randomUUID();

type Timeline = {
  thread: {
    thread_id: string;
    kind: "original" | "replay";
    parent_thread_id: string | null;
    source_checkpoint_id: string | null;
  };
  checkpoints: Array<{
    checkpoint_id: string;
    parent_checkpoint_id: string | null;
    node: string;
    next_nodes: string[];
    replayable: boolean;
    state_summary: { answerReady: boolean };
  }>;
};

async function post(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/rag/graph-follow-up/checkpoints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() as Record<string, any> };
}

const started = await fetch(`${baseUrl}/api/rag/graph-follow-up`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    thread_id: originalThreadId,
    query: "What should my near-side arm do against a knee cut?",
    provider: "openai",
    enable_checkpoint_replay: true,
    seed: {
      conversation: [{ question: "How do I stop a knee cut?", answer: "Frame and recover inside position." }],
      context_ids: [],
    },
  }),
});
const startPayload = await started.json() as {
  error?: string;
  answer?: { answer?: string };
  checkpoint_replay?: { access_token?: string };
};
const originalToken = startPayload.checkpoint_replay?.access_token;
if (!started.ok || !originalToken || !startPayload.answer?.answer) {
  throw new Error(startPayload.error ?? "Could not create a replay-enabled source thread.");
}

const firstList = await post({ action: "list", thread_id: originalThreadId, access_token: originalToken });
if (!firstList.response.ok) throw new Error(firstList.payload.error ?? "Could not list original checkpoints.");
const originalBefore = firstList.payload as Timeline;
const selected = originalBefore.checkpoints.find((checkpoint) => checkpoint.next_nodes.includes("commit_turn") && checkpoint.replayable);
if (!selected || !selected.state_summary.answerReady) {
  throw new Error("No successful pre-commit checkpoint with reusable answer state was found.");
}
const originalLatestId = originalBefore.checkpoints[0]?.checkpoint_id;
const originalCount = originalBefore.checkpoints.length;

const reclaim = await fetch(`${baseUrl}/api/rag/graph-follow-up`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    thread_id: originalThreadId,
    query: "Try to claim an existing thread",
    provider: "openai",
    enable_checkpoint_replay: true,
  }),
});
if (reclaim.status !== 409) throw new Error(`Existing-thread replay claim returned ${reclaim.status}, expected 409.`);

const unauthorized = await post({
  action: "list",
  thread_id: originalThreadId,
  access_token: crypto.randomUUID(),
});
if (unauthorized.response.status !== 403) throw new Error(`Unauthorized list returned ${unauthorized.response.status}, expected 403.`);

const invalid = await post({
  action: "replay",
  thread_id: originalThreadId,
  access_token: originalToken,
  checkpoint_id: crypto.randomUUID(),
});
if (invalid.response.status !== 404) throw new Error(`Unknown checkpoint returned ${invalid.response.status}, expected 404.`);

const replayed = await post({
  action: "replay",
  thread_id: originalThreadId,
  access_token: originalToken,
  checkpoint_id: selected.checkpoint_id,
  test_failure: "off",
});
if (!replayed.response.ok) throw new Error(replayed.payload.error ?? "Replay request failed.");
const branchThreadId = String(replayed.payload.branch?.thread_id ?? "");
const branchToken = String(replayed.payload.branch?.access_token ?? "");
const forkCheckpointId = String(replayed.payload.branch?.fork_checkpoint_id ?? "");
if (!branchThreadId || !branchToken || branchThreadId === originalThreadId) throw new Error("Replay did not create a separate authorized branch thread.");
if (replayed.payload.selected_checkpoint_id !== selected.checkpoint_id) throw new Error("Replay response did not identify the selected checkpoint.");
if (replayed.payload.result?.answer?.answer !== startPayload.answer.answer) throw new Error("The successful answer state at the selected checkpoint was not reused.");

const [secondList, branchList] = await Promise.all([
  post({ action: "list", thread_id: originalThreadId, access_token: originalToken }),
  post({ action: "list", thread_id: branchThreadId, access_token: branchToken }),
]);
if (!secondList.response.ok || !branchList.response.ok) throw new Error("Could not verify original and branch timelines.");
const originalAfter = secondList.payload as Timeline;
const branch = branchList.payload as Timeline;

if (originalAfter.checkpoints.length !== originalCount || originalAfter.checkpoints[0]?.checkpoint_id !== originalLatestId) {
  throw new Error("The original checkpoint trajectory changed during replay.");
}
if (branch.thread.kind !== "replay" || branch.thread.parent_thread_id !== originalThreadId) throw new Error("Branch provenance does not identify the original thread.");
if (branch.thread.source_checkpoint_id !== selected.checkpoint_id) throw new Error("Branch provenance does not identify the selected checkpoint.");
if (!branch.checkpoints.some((checkpoint) => checkpoint.checkpoint_id === selected.checkpoint_id)) throw new Error("The selected checkpoint was not cloned into the branch.");
const fork = branch.checkpoints.find((checkpoint) => checkpoint.checkpoint_id === forkCheckpointId);
if (!fork || fork.parent_checkpoint_id !== selected.checkpoint_id) throw new Error("The LangGraph fork checkpoint is not parented to the selected checkpoint.");
const reexecutedNodes = branch.checkpoints
  .filter((checkpoint) => checkpoint.checkpoint_id !== selected.checkpoint_id)
  .map((checkpoint) => checkpoint.node);
if (reexecutedNodes.some((node) => /retrieve|enrich|generate|validate/.test(node))) {
  throw new Error(`Completed nodes unexpectedly re-executed: ${JSON.stringify(reexecutedNodes)}`);
}

const crossedToken = await post({ action: "list", thread_id: originalThreadId, access_token: branchToken });
if (crossedToken.response.status !== 403) throw new Error("A branch capability token authorized the original thread.");

console.log(JSON.stringify({
  passed: true,
  original_thread_id: originalThreadId,
  original_checkpoint_count: originalCount,
  selected_checkpoint_id: selected.checkpoint_id,
  selected_next_nodes: selected.next_nodes,
  branch_thread_id: branchThreadId,
  fork_checkpoint_id: forkCheckpointId,
  branch_nodes_after_selection: reexecutedNodes,
  authorization_checks: { existing_thread_claim: 409, random_token: 403, unknown_checkpoint: 404, crossed_token: 403 },
}, null, 2));

export {};
