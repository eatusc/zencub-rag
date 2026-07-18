import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { resumeExperimentalFollowUp } from "@/lib/langgraph/followUpGraph";
import { recoveryExecutionCounts } from "@/lib/langgraph/testEvents";

export const runtime = "nodejs";

function uuid(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

export async function POST(request: NextRequest) {
  const env = getServerEnv();
  if (!env.langGraphTestMode) return NextResponse.json({ error: "LangGraph recovery test mode is disabled." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { thread_id?: unknown };
  const threadId = uuid(body.thread_id);
  if (!threadId) return NextResponse.json({ error: "A valid thread_id is required." }, { status: 400 });

  try {
    const result = await resumeExperimentalFollowUp(threadId);
    const executionCounts = await recoveryExecutionCounts(threadId);
    return NextResponse.json({
      status: "recovered",
      thread_id: threadId,
      turn_index: result.turnIndex,
      answer: result.answer,
      trace: result.trace,
      execution_counts: executionCounts,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
