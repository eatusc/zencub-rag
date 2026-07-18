import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import {
  listExperimentalFollowUpCheckpoints,
  replayExperimentalFollowUp,
} from "@/lib/langgraph/followUpGraph";
import {
  authorizeReplayThread,
  registerReplayThread,
} from "@/lib/langgraph/replayAuthorization";

export const runtime = "nodejs";

function uuid(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

function checkpointId(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f-]{16,80}$/i.test(candidate) ? candidate : null;
}

export async function POST(request: NextRequest) {
  const env = getServerEnv();
  if (!env.langGraphTestMode) {
    return NextResponse.json({ error: "LangGraph checkpoint replay is disabled outside explicit test mode." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  const threadId = uuid(body.thread_id);
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!threadId || !accessToken) {
    return NextResponse.json({ error: "A valid thread_id and replay access token are required." }, { status: 400 });
  }

  try {
    const authorization = await authorizeReplayThread(threadId, accessToken);
    if (!authorization) return NextResponse.json({ error: "Replay access was not authorized for this thread." }, { status: 403 });

    if (action === "list") {
      const checkpoints = await listExperimentalFollowUpCheckpoints(threadId);
      return NextResponse.json({
        thread: {
          thread_id: authorization.threadId,
          kind: authorization.kind,
          parent_thread_id: authorization.parentThreadId,
          source_checkpoint_id: authorization.sourceCheckpointId,
          test_config: authorization.testConfig,
          created_at: authorization.createdAt,
        },
        checkpoints: checkpoints.map((checkpoint) => ({
          checkpoint_id: checkpoint.checkpointId,
          parent_checkpoint_id: checkpoint.parentCheckpointId,
          created_at: checkpoint.createdAt,
          node: checkpoint.node,
          next_nodes: checkpoint.nextNodes,
          step: checkpoint.step,
          source: checkpoint.source,
          replayable: checkpoint.replayable,
          test_config: checkpoint.testConfig,
          state_summary: checkpoint.stateSummary,
        })),
      });
    }

    if (action === "replay") {
      const selectedCheckpointId = checkpointId(body.checkpoint_id);
      if (!selectedCheckpointId) return NextResponse.json({ error: "A valid checkpoint_id is required." }, { status: 400 });
      const available = await listExperimentalFollowUpCheckpoints(threadId);
      const selected = available.find((checkpoint) => checkpoint.checkpointId === selectedCheckpointId);
      if (!selected) return NextResponse.json({ error: "Checkpoint not found on the authorized thread." }, { status: 404 });
      if (!selected.replayable) return NextResponse.json({ error: "The selected checkpoint is not replayable." }, { status: 409 });

      const testFailure = body.test_failure === "rerank_once" ? "rerank_once" as const : null;
      const branchThreadId = crypto.randomUUID();
      const branch = await registerReplayThread({
        threadId: branchThreadId,
        kind: "replay",
        parentThreadId: threadId,
        sourceCheckpointId: selectedCheckpointId,
        testConfig: { failure: testFailure, mode: "checkpoint_replay" },
      });
      try {
        const replay = await replayExperimentalFollowUp({
          sourceThreadId: threadId,
          checkpointId: selectedCheckpointId,
          branchThreadId,
          testFailure,
        });
        return NextResponse.json({
          status: "replayed",
          original_thread_id: threadId,
          selected_checkpoint_id: selectedCheckpointId,
          branch: {
            thread_id: branchThreadId,
            access_token: branch.accessToken,
            parent_thread_id: threadId,
            source_checkpoint_id: selectedCheckpointId,
            fork_checkpoint_id: replay.forkCheckpointId,
          },
          result: {
            turn_index: replay.result.turnIndex,
            relationship: replay.result.relationship,
            provider: replay.result.provider,
            model: replay.result.model,
            answer: replay.result.answer,
            trace: replay.result.trace,
          },
        });
      } catch (error) {
        return NextResponse.json({
          error: error instanceof Error ? error.message : "Checkpoint replay failed.",
          original_thread_id: threadId,
          selected_checkpoint_id: selectedCheckpointId,
          branch: { thread_id: branchThreadId, access_token: branch.accessToken },
        }, { status: 500 });
      }
    }

    return NextResponse.json({ error: "Action must be list or replay." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Checkpoint request failed." }, { status: 500 });
  }
}
