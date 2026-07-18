import { createServerSupabase } from "@/lib/supabase";

export type RecoveryNode = "vector" | "keyword" | "metadata" | "context" | "fuse" | "rerank";

export async function logRecoveryExecution(threadId: string, node: RecoveryNode): Promise<void> {
  const supabase = createServerSupabase();
  const { error } = await supabase.from("rag_langgraph_test_events").insert({
    thread_id: threadId,
    node,
    event: "execute",
  });
  if (error) throw new Error(`Recovery test logging failed: ${error.message}`);
}

export async function claimFailureInjection(threadId: string, node: RecoveryNode): Promise<boolean> {
  const supabase = createServerSupabase();
  const { error } = await supabase.from("rag_langgraph_test_events").insert({
    thread_id: threadId,
    node,
    event: "failure_injected",
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`Failure injection claim failed: ${error.message}`);
}

export async function recoveryExecutionCounts(threadId: string): Promise<Record<string, number>> {
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_langgraph_test_events")
    .select("node,event")
    .eq("thread_id", threadId)
    .eq("event", "execute");
  if (error) throw new Error(error.message);
  return (data ?? []).reduce<Record<string, number>>((counts, row) => {
    const node = String(row.node);
    counts[node] = (counts[node] ?? 0) + 1;
    return counts;
  }, {});
}

export async function clearRecoveryEvents(threadId: string): Promise<void> {
  const supabase = createServerSupabase();
  const { error } = await supabase.from("rag_langgraph_test_events").delete().eq("thread_id", threadId);
  if (error) throw new Error(error.message);
}
