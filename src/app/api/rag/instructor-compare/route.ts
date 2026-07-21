import { NextRequest, NextResponse } from "next/server";
import { probeQwen, providerModel } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { listInstructorCompareRuns, storeInstructorCompareRun } from "@/lib/instructorCompareStorage";
import {
  authorizeInstructorCompareSession,
  instructorCompareSessionToken,
} from "@/lib/langgraph/instructorCompareAuthorization";
import {
  branchInstructorComparison,
  continueInstructorComparison,
  recoverInstructorComparison,
  resumeInstructorComparison,
  runInstructorComparison,
  startGuidedInstructorComparison,
  type InstructorCompareWorkflowResult,
} from "@/lib/langgraph/instructorCompareGraph";
import { normalizeProvider } from "@/lib/providers";
import { logSearch } from "@/lib/searchLogging";
import type {
  RagInstructorComparePausedResponse,
  RagInstructorCompareResponse,
  RagInstructorPanelDecision,
} from "@/lib/types";

export const runtime = "nodejs";

type SupportedProvider = "qwen" | "openrouter" | "openai";
type CompletedWorkflow = Extract<InstructorCompareWorkflowResult, { status: "complete" }>;

function uuid(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

function queryValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerValue(value: unknown, fallback: SupportedProvider = "openrouter"): SupportedProvider | null {
  const normalized = value === undefined ? fallback : normalizeProvider(value);
  return normalized && normalized !== "claude" ? normalized : null;
}

function panelDecision(value: unknown): RagInstructorPanelDecision | null {
  if (!value || typeof value !== "object") return null;
  const decision = value as Record<string, unknown>;
  if (decision.action === "approve" || decision.action === "reject") return { action: decision.action };
  if (decision.action === "edit" && Array.isArray(decision.excluded_clip_ids)) {
    return { action: "edit", excluded_clip_ids: decision.excluded_clip_ids.map(Number).filter(Number.isInteger).slice(0, 20) };
  }
  return null;
}

async function providerError(provider: SupportedProvider): Promise<string | null> {
  const env = getServerEnv();
  if (provider === "qwen" && !await probeQwen(env)) return `Local Qwen model ${env.ragQwenModel} is not currently available.`;
  if (provider === "openrouter" && !env.openRouterApiKey) return "Qwen3 235B requires OPENROUTER_API_KEY.";
  if (provider === "openai" && !env.openaiApiKey) return "GPT-4o Mini requires OPENAI_API_KEY.";
  return null;
}

function fullResponse(input: {
  threadId: string;
  token?: string;
  query: string;
  provider: SupportedProvider;
  result: CompletedWorkflow["result"];
  totalMs: number;
}): RagInstructorCompareResponse {
  const env = getServerEnv();
  const model = providerModel(input.provider, env);
  return {
    query: input.query,
    engine: "langgraph",
    thread_id: input.threadId,
    ...(input.token ? { session_token: input.token } : {}),
    provider: input.provider,
    model,
    models: {
      semantic_embedding: input.provider === "qwen" ? null : env.openaiApiKey ? env.ragEmbeddingModel : null,
      evidence_reranker: input.result.rerank_applied ? model : null,
      instructor_analysis: model,
      synthesis: model,
      claim_verifier: model,
    },
    zero_paid_model_mode: input.provider === "qwen",
    ...input.result,
    total_ms: input.totalMs,
  };
}

async function workflowResponse(input: {
  workflow: InstructorCompareWorkflowResult;
  threadId: string;
  token: string;
  startedAt: number;
}) {
  if (input.workflow.status === "paused") {
    const response: RagInstructorComparePausedResponse = {
      status: "paused",
      engine: "langgraph",
      thread_id: input.threadId,
      session_token: input.token,
      proposal: input.workflow.proposal,
      trace: input.workflow.trace,
      checkpoint_count: input.workflow.checkpointCount,
    };
    return NextResponse.json(response);
  }
  if (input.workflow.status === "rejected") {
    return NextResponse.json({ status: "rejected", thread_id: input.threadId, trace: input.workflow.trace, checkpoint_count: input.workflow.checkpointCount });
  }
  const response = fullResponse({
    threadId: input.threadId,
    token: input.token,
    query: input.workflow.query,
    provider: input.workflow.provider,
    result: input.workflow.result,
    totalMs: Math.round(performance.now() - input.startedAt),
  });
  const stored = await storeInstructorCompareRun(response);
  return NextResponse.json({ ...stored, session_token: input.token });
}

export async function GET(request: NextRequest) {
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
  const requestedOffset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const offset = Number.isInteger(requestedOffset) ? Math.min(Math.max(requestedOffset, 0), 10_000) : 0;
  const normalized = normalizeProvider(request.nextUrl.searchParams.get("provider"));
  const provider = normalized && normalized !== "claude" ? normalized : undefined;
  try {
    return NextResponse.json(await listInstructorCompareRuns({ limit, offset, provider }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Instructor comparison history failed." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "run";
  const query = queryValue(body.query);
  const provider = providerValue(body.provider);
  const requestedCount = Number(body.instructor_count);
  const instructorCount = Number.isInteger(requestedCount) ? Math.min(Math.max(requestedCount, 2), 5) : 3;
  const env = getServerEnv();

  if (["run", "start", "follow_up", "experiment"].includes(action)) {
    if (query.length < 2) return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
    if (query.length > 1_000) return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });
  }
  if (!provider) return NextResponse.json({ error: "Instructor Compare supports qwen, openrouter, or openai." }, { status: 400 });
  const unavailable = await providerError(provider);
  if (unavailable) return NextResponse.json({ error: unavailable }, { status: 503 });

  const existingThreadId = uuid(body.thread_id);
  const token = typeof body.session_token === "string" ? body.session_token : "";
  if (["resume", "follow_up", "recover", "experiment"].includes(action)) {
    if (!existingThreadId || !authorizeInstructorCompareSession(existingThreadId, token)) {
      return NextResponse.json({ error: "A valid Instructor Compare thread and capability token are required." }, { status: 403 });
    }
  }

  const startedAt = performance.now();
  try {
    if (action === "run") {
      const threadId = crypto.randomUUID();
      await logSearch({ query, action: "ask", provider, retrieval: "hybrid", metadata: { workflow: "instructor_compare", requested_instructors: instructorCount } });
      const result = await runInstructorComparison({ threadId, query, instructorCount, provider });
      return NextResponse.json(await storeInstructorCompareRun(fullResponse({ threadId, query, provider, result, totalMs: Math.round(performance.now() - startedAt) })));
    }

    if (action === "start") {
      const threadId = crypto.randomUUID();
      const sessionToken = instructorCompareSessionToken(threadId);
      await logSearch({ query, action: "ask", provider, retrieval: "hybrid", metadata: { workflow: "instructor_compare_guided", requested_instructors: instructorCount } });
      const failureSlug = env.langGraphTestMode && typeof body.test_failure_slug === "string" ? body.test_failure_slug.slice(0, 100) : null;
      const workflow = await startGuidedInstructorComparison({ threadId, query, instructorCount, provider, testFailureSlug: failureSlug });
      return workflowResponse({ workflow, threadId, token: sessionToken, startedAt });
    }

    if (action === "resume") {
      const decision = panelDecision(body.decision);
      if (!decision) return NextResponse.json({ error: "A valid approve, edit, or reject decision is required." }, { status: 400 });
      const workflow = await resumeInstructorComparison({ threadId: existingThreadId!, decision });
      return workflowResponse({ workflow, threadId: existingThreadId!, token, startedAt });
    }

    if (action === "follow_up") {
      const workflow = await continueInstructorComparison({ threadId: existingThreadId!, query, provider });
      return workflowResponse({ workflow, threadId: existingThreadId!, token, startedAt });
    }

    if (action === "recover") {
      const workflow = await recoverInstructorComparison(existingThreadId!);
      return workflowResponse({ workflow, threadId: existingThreadId!, token, startedAt });
    }

    if (action === "experiment") {
      const branchThreadId = crypto.randomUUID();
      const branchToken = instructorCompareSessionToken(branchThreadId);
      const branch = await branchInstructorComparison({ sourceThreadId: existingThreadId!, branchThreadId, provider });
      const response = fullResponse({ threadId: branchThreadId, token: branchToken, query, provider, result: branch.result, totalMs: Math.round(performance.now() - startedAt) });
      const stored = await storeInstructorCompareRun(response);
      return NextResponse.json({ ...stored, session_token: branchToken, branch: { original_thread_id: existingThreadId, source_checkpoint_id: branch.sourceCheckpointId, fork_checkpoint_id: branch.forkCheckpointId } });
    }

    return NextResponse.json({ error: "Unknown Instructor Compare action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown comparison error";
    return NextResponse.json({ error: message.replace(/^INSUFFICIENT_INSTRUCTORS:\s*/, ""), thread_id: existingThreadId, session_token: token || undefined, recoverable: action !== "run" }, {
      status: message.startsWith("INSUFFICIENT_INSTRUCTORS") ? 422 : 500,
    });
  }
}
