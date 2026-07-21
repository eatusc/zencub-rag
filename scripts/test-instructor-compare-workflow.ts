const baseUrl = (process.env.RAG_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const endpoint = `${baseUrl}/api/rag/instructor-compare`;
const provider = process.argv[2] ?? "openrouter";
const query = "Compare how instructors defend the knee cut after the passer wins the crossface";

async function post(body: Record<string, unknown>, expected = 200) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, any>;
  if (response.status !== expected) throw new Error(payload.error ?? `Expected ${expected}, received ${response.status}.`);
  return payload;
}

const paused = await post({ action: "start", query, instructor_count: 3, provider });
if (paused.status !== "paused" || paused.proposal?.kind !== "instructor_panel_review") throw new Error("The guided workflow did not pause at evidence review.");
if (!paused.session_token || paused.proposal.instructors.length < 2) throw new Error("The pause did not include a capability or viable instructor panel.");

await post({
  action: "resume",
  thread_id: paused.thread_id,
  session_token: "not-authorized",
  provider,
  decision: { action: "approve" },
}, 403);

const completed = await post({
  action: "resume",
  thread_id: paused.thread_id,
  session_token: paused.session_token,
  provider,
  decision: { action: "approve" },
});
if (completed.thread_id !== paused.thread_id || completed.session?.turn_index !== 1) throw new Error("Approval did not resume and commit the original thread.");
if (!completed.claim_verifications?.length || !completed.trace?.some((entry: Record<string, unknown>) => String(entry.node).startsWith("compare_verify:"))) {
  throw new Error("Independent claim-verifier branches did not execute.");
}
if (!completed.trace.some((entry: Record<string, unknown>) => entry.node === "compare_panel_review")) throw new Error("The human-review resume was not visible in the trace.");
if (!completed.quality || completed.quality.refinement_rounds > completed.quality.max_refinement_rounds) throw new Error("The bounded quality loop reported invalid state.");
if (!completed.stored_run_id) throw new Error("The completed guided run was not stored.");

console.log(JSON.stringify({
  passed: true,
  thread_id: completed.thread_id,
  paused_checkpoint_count: paused.checkpoint_count,
  panel: paused.proposal.instructors.map((item: Record<string, any>) => ({ name: item.creator_name, clips: item.clips.length })),
  refinement_rounds: completed.quality.refinement_rounds,
  verified_claims: completed.claim_verifications.filter((item: Record<string, unknown>) => item.passed).length,
  removed_claims: completed.claim_verifications.filter((item: Record<string, unknown>) => !item.passed).length,
  per_turn_tokens: completed.usage.total_tokens,
  unauthorized_status: 403,
  stored_run_id: completed.stored_run_id,
}, null, 2));

export {};
