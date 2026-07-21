import { CallbackHandler } from "@langfuse/langchain";

// Returns a LangChain callback that emits OpenTelemetry spans to Langfuse.
// Attach to the TOP-LEVEL compiled-graph .invoke()/.stream() config — callbacks
// propagate to all child nodes/LLM calls automatically. Returns [] when Langfuse
// isn't configured, so calls are safe no-ops in that case.
export function langfuseCallbacks(): CallbackHandler[] {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return [];
  return [new CallbackHandler()];
}
