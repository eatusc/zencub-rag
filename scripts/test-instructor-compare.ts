const baseUrl = (process.env.RAG_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const query = "Compare how instructors defend the knee cut after the passer wins the crossface";
const provider = process.argv[2] ?? "openrouter";
if (!["qwen", "openrouter", "openai"].includes(provider)) throw new Error(`Unsupported test provider: ${provider}`);

const response = await fetch(`${baseUrl}/api/rag/instructor-compare`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, instructor_count: 3, provider }),
});
const payload = await response.json() as Record<string, any>;
if (!response.ok) throw new Error(payload.error ?? `Comparison returned ${response.status}.`);

const instructors = payload.comparison?.instructors ?? [];
const slugs = instructors.map((instructor: Record<string, unknown>) => instructor.creator_slug);
if (instructors.length !== 3 || new Set(slugs).size !== 3) throw new Error("Expected three distinct canonical instructors.");
if (!instructors.every((instructor: Record<string, any>) => instructor.attribution_confidence >= 0.7 && instructor.citations?.length > 0)) {
  throw new Error("Every instructor must have high-confidence attribution and a verified citation.");
}

const traceNodes = (payload.trace ?? []).map((entry: Record<string, unknown>) => String(entry.node));
for (const required of ["compare_vector", "compare_keyword", "compare_metadata", "compare_fuse", "compare_attribute", "compare_panel", "compare_synthesize", "compare_validate"]) {
  if (!traceNodes.includes(required)) throw new Error(`Missing graph trace node ${required}.`);
}
if (traceNodes.filter((node: string) => node.startsWith("compare_instructor:")).length !== 3) {
  throw new Error("Expected one dynamic LangGraph branch per instructor.");
}
if (Number(payload.checkpoint_count) < 7) throw new Error("Expected durable checkpoints across the comparison workflow.");
if (!payload.models?.instructor_analysis || !payload.models?.synthesis) {
  throw new Error("The response did not identify the models actually used by each stage.");
}
if (payload.provider !== provider) throw new Error(`Expected provider ${provider}, received ${payload.provider}.`);
if (provider === "qwen" && (payload.models.semantic_embedding !== null || payload.zero_paid_model_mode !== true)) {
  throw new Error("Local Qwen must disable paid semantic embeddings and identify zero-paid mode.");
}
if (provider !== "qwen" && payload.zero_paid_model_mode !== false) throw new Error("Remote provider was incorrectly marked zero-paid.");
if (!payload.usage || payload.usage.reported_calls < 4 || payload.usage.total_tokens <= 0) {
  throw new Error("Expected model-reported token usage for all analysis and synthesis calls.");
}
if (!payload.usage.model_calls.every((call: Record<string, unknown>) => call.provider === provider && Number(call.total_tokens) > 0 && Number(call.ms) >= 0)) {
  throw new Error("Per-stage provider, duration, or token telemetry is incomplete.");
}
if (!payload.stored_run_id || !payload.stored_at) throw new Error("Successful comparison was not durably stored.");
if (payload.attribution?.attributed_candidates < 3 || payload.attribution?.minimum_confidence !== 0.7) {
  throw new Error("Canonical attribution evidence is incomplete.");
}

const crossInstructorClaims = [
  ...(payload.comparison?.shared_principles ?? []),
  ...(payload.comparison?.important_differences ?? []),
];
for (const claim of crossInstructorClaims) {
  const citedInstructors = new Set((claim.citations ?? []).map((citation: Record<string, unknown>) => citation.channel));
  if (citedInstructors.size < 2) throw new Error("A cross-instructor claim survived without citations from two instructors.");
}

function containsPrivateKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    ["vector", "keyword", "metadata", "candidates", "attributedCandidates", "groups", "activeGroup", "session_token"].includes(key)
      || containsPrivateKey(nested));
}
if (containsPrivateKey(payload)) throw new Error("Private graph candidate state leaked into the API response.");

const historyResponse = await fetch(`${baseUrl}/api/rag/instructor-compare?limit=100`, { cache: "no-store" });
const history = await historyResponse.json() as Record<string, any>;
if (!historyResponse.ok) throw new Error(history.error ?? "Stored comparison history could not be loaded.");
const stored = (history.runs ?? []).find((run: Record<string, unknown>) => run.stored_run_id === payload.stored_run_id);
if (!stored || stored.thread_id !== payload.thread_id || stored.comparison?.topic !== payload.comparison.topic) {
  throw new Error("The exact completed comparison was not returned by durable history.");
}
if (containsPrivateKey(stored)) throw new Error("Private candidate state leaked into stored comparison history.");

const invalid = await fetch(`${baseUrl}/api/rag/instructor-compare`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: "x" }),
});
if (invalid.status !== 400) throw new Error(`Invalid query returned ${invalid.status}, expected 400.`);

const unsupportedProvider = await fetch(`${baseUrl}/api/rag/instructor-compare`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, provider: "claude" }),
});
if (unsupportedProvider.status !== 400) throw new Error(`Unsupported provider returned ${unsupportedProvider.status}, expected 400.`);

console.log(JSON.stringify({
  passed: true,
  thread_id: payload.thread_id,
  instructors: instructors.map((instructor: Record<string, any>) => ({
    name: instructor.creator_name,
    attribution_confidence: instructor.attribution_confidence,
    citations: instructor.citations.length,
  })),
  evidence_count: payload.evidence_count,
  shared_principles: payload.comparison.shared_principles.length,
  important_differences: payload.comparison.important_differences.length,
  checkpoint_count: payload.checkpoint_count,
  rerank_applied: payload.rerank_applied,
  provider: payload.provider,
  models: payload.models,
  total_ms: payload.total_ms,
  usage: payload.usage,
  zero_paid_model_mode: payload.zero_paid_model_mode,
  stored_run_id: payload.stored_run_id,
  stored_at: payload.stored_at,
  stored_history_total: history.total,
  trace_nodes: traceNodes,
  private_state_exposed: false,
  invalid_query_status: invalid.status,
  unsupported_provider_status: unsupportedProvider.status,
}, null, 2));

export {};
