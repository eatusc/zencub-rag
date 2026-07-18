import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { resumeNoteReview, startNoteReview, type NoteReviewDecision } from "@/lib/langgraph/noteGraph";

export const runtime = "nodejs";

function uuid(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function decision(value: unknown): NoteReviewDecision | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.action === "approve" || raw.action === "reject") return { action: raw.action };
  if (raw.action === "edit") {
    const title = text(raw.title, 200);
    const content = text(raw.content, 20_000);
    return title && content ? { action: "edit", title, content } : null;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!getServerEnv().langGraphTestMode) {
    return NextResponse.json({ error: "LangGraph note approval is disabled outside explicit test mode." }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  try {
    if (action === "start") {
      const threadId = uuid(body.thread_id) ?? crypto.randomUUID();
      const noteKey = uuid(body.note_key) ?? crypto.randomUUID();
      const title = text(body.title, 200);
      const content = text(body.content, 20_000);
      if (!title || !content) return NextResponse.json({ error: "Title and content are required." }, { status: 400 });
      const { proposal } = await startNoteReview({ noteKey, threadId, title, content });
      if (!proposal) return NextResponse.json({ error: "The note graph did not pause for review." }, { status: 500 });
      return NextResponse.json({ status: "pending_review", note_key: noteKey, thread_id: threadId, proposal });
    }

    if (action === "resume") {
      const noteKey = uuid(body.note_key);
      const reviewDecision = decision(body.decision);
      if (!noteKey || !reviewDecision) return NextResponse.json({ error: "A valid note_key and decision are required." }, { status: 400 });
      const result = await resumeNoteReview(noteKey, reviewDecision);
      return NextResponse.json({
        status: result.status,
        note_key: noteKey,
        note_id: result.noteId,
        title: result.title,
        content: result.content,
      });
    }

    return NextResponse.json({ error: "Action must be start or resume." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
