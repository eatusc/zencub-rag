// Public Instructor Compare API (instructors.zencub.com).
//
// POST starts a comparison and returns immediately with a thread id; GET polls
// it. The split exists because the workflow runs about a minute and has been
// measured at 114 seconds, while Cloudflare gives an origin 100 to respond. It
// also gives the UI something better than a spinner: the poll returns the graph
// trace as nodes finish, so a reader watches retrieval, the instructor branches
// fanning out, and each claim being verified.
//
// Unlike the internal demo route, nothing here is caller-configurable. The
// provider is pinned server-side, the instructor count is fixed, and there is
// no test-mode surface at all.

import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { atCapacity, getJob, startJob } from "@/lib/instructorCompareJobs";
import { storeInstructorCompareRun } from "@/lib/instructorCompareStorage";
import {
  authorizeInstructorCompareSession,
  instructorCompareSessionToken,
} from "@/lib/langgraph/instructorCompareAuthorization";
import {
  continueInstructorComparisonStreamed,
  instructorCompareThreadExists,
  runInstructorComparisonStreamed,
} from "@/lib/langgraph/instructorCompareGraph";
import { publicInstructorsProvider } from "@/lib/appMode";
import { providerModel } from "@/lib/answerProviders";
import { logSearch } from "@/lib/searchLogging";
import { clientSafeError, logWorkflowError } from "@/lib/workflowErrors";
import type { RagInstructorCompareResponse, RagStoredInstructorCompareRun } from "@/lib/types";

export const runtime = "nodejs";

const INSTRUCTOR_COUNT = 3;
const MIN_QUERY = 3;
const MAX_QUERY = 300;

function uuid(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

function response(
  threadId: string,
  query: string,
  result: Awaited<ReturnType<typeof runInstructorComparisonStreamed>>,
  totalMs: number,
): RagInstructorCompareResponse {
  const env = getServerEnv();
  const provider = publicInstructorsProvider();
  const model = providerModel(provider, env);
  return {
    query,
    engine: "langgraph",
    thread_id: threadId,
    provider,
    model,
    models: {
      semantic_embedding: env.openaiApiKey ? env.ragEmbeddingModel : null,
      evidence_reranker: result.rerank_applied ? model : null,
      instructor_analysis: model,
      synthesis: model,
      claim_verifier: model,
    },
    zero_paid_model_mode: false,
    ...result,
    total_ms: totalMs,
  };
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const threadId = uuid(body.thread_id);
  const token = typeof body.session_token === "string" ? body.session_token : "";

  if (query.length < MIN_QUERY) {
    return NextResponse.json({ error: "Ask about a position or a technique, in a few words." }, { status: 400 });
  }
  if (query.length > MAX_QUERY) {
    return NextResponse.json({ error: `Keep the question under ${MAX_QUERY} characters.` }, { status: 400 });
  }

  const env = getServerEnv();
  const provider = publicInstructorsProvider();
  if (provider === "openai" && !env.openaiApiKey) {
    return NextResponse.json({ error: "Comparisons are temporarily unavailable." }, { status: 503 });
  }
  if (provider === "openrouter" && !env.openRouterApiKey) {
    return NextResponse.json({ error: "Comparisons are temporarily unavailable." }, { status: 503 });
  }

  // A follow-up needs both the thread and the capability token minted when that
  // thread was created, so a thread id alone cannot be used to continue
  // somebody else's research session.
  const isFollowUp = Boolean(threadId && token);
  if (threadId && !isFollowUp) {
    return NextResponse.json({ error: "A follow-up needs its session token." }, { status: 403 });
  }
  if (isFollowUp && !authorizeInstructorCompareSession(threadId!, token)) {
    return NextResponse.json({ error: "This research session has expired. Start a new comparison." }, { status: 403 });
  }
  if (isFollowUp && !(await instructorCompareThreadExists(threadId!))) {
    return NextResponse.json({ error: "This research session is no longer available. Start a new comparison." }, { status: 404 });
  }

  // One reader per slot rather than one queue: a comparison is a dozen model
  // calls, several running at once, so a handful in flight is the point at
  // which everybody's run gets slower.
  if (atCapacity()) {
    return NextResponse.json(
      { error: "A few comparisons are already running. Try again in a minute." },
      { status: 503, headers: { "retry-after": "60" } },
    );
  }

  const activeThreadId = isFollowUp ? threadId! : crypto.randomUUID();
  const sessionToken = isFollowUp ? token : instructorCompareSessionToken(activeThreadId);
  const startedAt = performance.now();

  await logSearch({
    query,
    action: isFollowUp ? "follow_up" : "ask",
    provider,
    retrieval: "hybrid",
    metadata: { workflow: "instructors_public", surface: "instructors", thread_id: activeThreadId },
  });

  startJob({
    threadId: activeThreadId,
    query,
    onError: (error) => logWorkflowError("instructors-compare", error),
    work: async (onProgress): Promise<RagStoredInstructorCompareRun> => {
      const result = isFollowUp
        ? await continueInstructorComparisonStreamed({ threadId: activeThreadId, query, provider, onProgress })
        : await runInstructorComparisonStreamed({
          threadId: activeThreadId,
          query,
          instructorCount: INSTRUCTOR_COUNT,
          provider,
          onProgress,
        });
      const totalMs = Math.round(performance.now() - startedAt);
      return storeInstructorCompareRun(response(activeThreadId, query, result, totalMs), { surface: "instructors" });
    },
  });

  return NextResponse.json({
    status: "running",
    thread_id: activeThreadId,
    session_token: sessionToken,
    relationship: isFollowUp ? "follow_up" : "initial",
  }, { status: 202 });
}

export async function GET(request: NextRequest) {
  const threadId = uuid(request.nextUrl.searchParams.get("thread_id"));
  if (!threadId) return NextResponse.json({ error: "A valid thread_id is required." }, { status: 400 });

  const job = getJob(threadId);
  if (!job) {
    // Either the id was never ours, or the server restarted mid-run. Both look
    // the same to a reader and both are recoverable by asking again.
    return NextResponse.json({ error: "That comparison is no longer in progress." }, { status: 404 });
  }

  if (job.status === "error") {
    return NextResponse.json({
      status: "error",
      thread_id: threadId,
      trace: job.trace,
      error: clientSafeError(job.error ?? ""),
    });
  }

  return NextResponse.json({
    status: job.status,
    thread_id: threadId,
    elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
    trace: job.trace,
    ...(job.result ? { result: job.result } : {}),
  });
}
