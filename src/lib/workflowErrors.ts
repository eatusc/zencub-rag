// What a workflow failure is allowed to tell the browser.
//
// The graph throws through several layers that carry infrastructure detail in
// their messages: Supabase returns "... failed: relation rag_x does not exist",
// the OpenAI SDK includes request IDs and org identifiers, the checkpointer
// names its schema. None of that helps a reader and all of it describes the
// inside of the server, so only messages the workflow raises deliberately are
// passed through verbatim.

// Prefixes the graph raises on purpose, meant to be read by a person.
const USER_FACING_PREFIXES = ["INSUFFICIENT_INSTRUCTORS:"] as const;

const GENERIC = "The comparison could not be completed. Please try again.";

export function clientSafeError(message: string, testMode = false): string {
  for (const prefix of USER_FACING_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length).trim();
  }
  // Test mode is an intentional local rig, where the raw message is the point.
  if (testMode) return message;
  return GENERIC;
}

// Errors still need to be diagnosable, so the unredacted message goes to the
// process log where only the operator can see it.
export function logWorkflowError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${context}] ${message}`);
}
