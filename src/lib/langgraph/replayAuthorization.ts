import { createHash, randomBytes } from "node:crypto";
import { createServerSupabase } from "@/lib/supabase";

export type ReplayThreadKind = "original" | "replay";

export type ReplayThreadAuthorization = {
  threadId: string;
  kind: ReplayThreadKind;
  parentThreadId: string | null;
  sourceCheckpointId: string | null;
  testConfig: Record<string, unknown>;
  createdAt: string;
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function registerReplayThread(input: {
  threadId: string;
  kind: ReplayThreadKind;
  parentThreadId?: string | null;
  sourceCheckpointId?: string | null;
  testConfig?: Record<string, unknown>;
}): Promise<{ accessToken: string; authorization: ReplayThreadAuthorization }> {
  const accessToken = randomBytes(32).toString("base64url");
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_langgraph_replay_threads")
    .insert({
      thread_id: input.threadId,
      access_token_hash: tokenHash(accessToken),
      thread_kind: input.kind,
      parent_thread_id: input.parentThreadId ?? null,
      source_checkpoint_id: input.sourceCheckpointId ?? null,
      test_config: input.testConfig ?? {},
    })
    .select("thread_id,thread_kind,parent_thread_id,source_checkpoint_id,test_config,created_at")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("This thread already has replay authorization.");
    throw new Error(`Replay authorization setup failed: ${error.message}`);
  }
  return {
    accessToken,
    authorization: {
      threadId: String(data.thread_id),
      kind: data.thread_kind as ReplayThreadKind,
      parentThreadId: data.parent_thread_id ? String(data.parent_thread_id) : null,
      sourceCheckpointId: data.source_checkpoint_id ? String(data.source_checkpoint_id) : null,
      testConfig: data.test_config && typeof data.test_config === "object"
        ? data.test_config as Record<string, unknown>
        : {},
      createdAt: String(data.created_at),
    },
  };
}

export async function authorizeReplayThread(threadId: string, accessToken: string): Promise<ReplayThreadAuthorization | null> {
  if (accessToken.length < 32 || accessToken.length > 200) return null;
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_langgraph_replay_threads")
    .select("thread_id,thread_kind,parent_thread_id,source_checkpoint_id,test_config,created_at")
    .eq("thread_id", threadId)
    .eq("access_token_hash", tokenHash(accessToken))
    .maybeSingle();
  if (error) throw new Error(`Replay authorization check failed: ${error.message}`);
  if (!data) return null;
  return {
    threadId: String(data.thread_id),
    kind: data.thread_kind as ReplayThreadKind,
    parentThreadId: data.parent_thread_id ? String(data.parent_thread_id) : null,
    sourceCheckpointId: data.source_checkpoint_id ? String(data.source_checkpoint_id) : null,
    testConfig: data.test_config && typeof data.test_config === "object"
      ? data.test_config as Record<string, unknown>
      : {},
    createdAt: String(data.created_at),
  };
}
