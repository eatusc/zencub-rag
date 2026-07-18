import { NextRequest, NextResponse } from "next/server";
import { probeQwen } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { logFollowUpExperiment } from "@/lib/followUpExperimentLogging";
import { listExperimentalFollowUpCheckpoints, runExperimentalFollowUp } from "@/lib/langgraph/followUpGraph";
import { registerReplayThread } from "@/lib/langgraph/replayAuthorization";
import { normalizeProvider, type AnswerProvider } from "@/lib/providers";
import { normalizeContextIds, normalizeConversation } from "@/lib/ragPipeline";
import { logSearch } from "@/lib/searchLogging";
import type { RagExperimentalFollowUpResponse } from "@/lib/types";

export const runtime = "nodejs";

function normalizeThreadId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    query?: unknown;
    provider?: unknown;
    thread_id?: unknown;
    seed?: {
      conversation?: unknown;
      context_ids?: unknown;
    };
    test_failure?: unknown;
    enable_checkpoint_replay?: unknown;
  };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedProvider = normalizeProvider(body.provider);
  const seedConversation = normalizeConversation(body.seed?.conversation);
  const seedContextIds = normalizeContextIds(body.seed?.context_ids);
  const threadId = normalizeThreadId(body.thread_id);
  const testFailure = body.test_failure === "rerank_once" ? "rerank_once" as const : null;
  const enableCheckpointReplay = body.enable_checkpoint_replay === true;

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }
  if (query.length > 1_000) {
    return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });
  }

  const env = getServerEnv();
  if (testFailure && !env.langGraphTestMode) {
    return NextResponse.json({ error: "LangGraph failure injection is disabled." }, { status: 403 });
  }
  if (enableCheckpointReplay && !env.langGraphTestMode) {
    return NextResponse.json({ error: "LangGraph checkpoint replay is disabled outside explicit test mode." }, { status: 403 });
  }
  const hasOpenai = Boolean(env.openaiApiKey);
  const hasOpenRouter = Boolean(env.openRouterApiKey);
  const provider: AnswerProvider = requestedProvider
    ?? ((await probeQwen(env)) ? "qwen" : hasOpenRouter ? "openrouter" : "openai");

  if (provider === "openrouter" && !hasOpenRouter) {
    return NextResponse.json({ error: "Missing OPENROUTER_API_KEY." }, { status: 500 });
  }
  if (provider === "openai" && !hasOpenai) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }

  await logSearch({
    query,
    action: "follow_up",
    provider,
    retrieval: "auto",
    metadata: {
      engine: "langgraph",
      state_source: "postgres_checkpoint",
      seeded_conversation_turns: seedConversation.length,
      seeded_context_sources: seedContextIds.length,
    },
  });

  const startedAt = performance.now();
  let replayAccessToken: string | null = null;
  try {
    if (enableCheckpointReplay) {
      const existingCheckpoints = await listExperimentalFollowUpCheckpoints(threadId, 1);
      if (existingCheckpoints.length > 0) {
        return NextResponse.json({ error: "Replay authorization can only be created with a new test thread." }, { status: 409 });
      }
      const replayAuthorization = await registerReplayThread({
        threadId,
        kind: "original",
        testConfig: { failure: testFailure, mode: "checkpoint_replay" },
      });
      replayAccessToken = replayAuthorization.accessToken;
    }
    const result = await runExperimentalFollowUp({
      threadId,
      query,
      provider,
      seedConversation,
      seedContextIds,
      testFailure,
    });
    const totalMs = Math.round(performance.now() - startedAt);
    if (!result.answer || !result.provider || result.sources.length === 0) {
      await logFollowUpExperiment({
        threadId,
        turnIndex: Math.max(1, result.turnIndex),
        query,
        requestedProvider: provider,
        relationship: result.relationship,
        retrieval: result.retrieval,
        sourceCount: result.sources.length,
        conversationTurns: result.conversationTurns,
        retainedContextSources: result.contextIds.length,
        durationMs: totalMs,
        trace: result.trace,
        success: false,
        errorCode: "no_sources",
      });
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    const response: RagExperimentalFollowUpResponse & {
      checkpoint_replay?: { access_token: string; thread_kind: "original" };
    } = {
      query,
      engine: "langgraph",
      thread_id: threadId,
      turn_index: result.turnIndex,
      relationship: result.relationship,
      provider: result.provider,
      model: result.model,
      retrieval: result.retrieval,
      reranked: result.reranked,
      source_count: result.sources.length,
      context_ids: result.contextIds,
      usage: result.usage,
      answer: result.answer,
      trace: result.trace,
      total_ms: totalMs,
      ...(replayAccessToken ? {
        checkpoint_replay: { access_token: replayAccessToken, thread_kind: "original" as const },
      } : {}),
    };

    await logFollowUpExperiment({
      threadId,
      turnIndex: result.turnIndex,
      query,
      requestedProvider: provider,
      actualProvider: result.provider,
      model: result.model,
      relationship: result.relationship,
      retrieval: result.retrieval,
      sourceCount: result.sources.length,
      conversationTurns: result.conversationTurns,
      retainedContextSources: result.contextIds.length,
      durationMs: totalMs,
      trace: result.trace,
      success: true,
      metadata: { reranked: result.reranked, persisted: true },
    });

    return NextResponse.json(response);
  } catch (error) {
    const totalMs = Math.round(performance.now() - startedAt);
    await logFollowUpExperiment({
      threadId,
      turnIndex: 1,
      query,
      requestedProvider: provider,
      conversationTurns: seedConversation.length,
      retainedContextSources: seedContextIds.length,
      durationMs: totalMs,
      success: false,
      errorCode: "graph_error",
    });
    const message = error instanceof Error ? error.message : "Unknown error";
    const recoverable = message.includes("LANGGRAPH_TEST_FAILURE");
    return NextResponse.json({
      error: message,
      thread_id: threadId,
      recoverable,
      ...(replayAccessToken ? {
        checkpoint_replay: { access_token: replayAccessToken, thread_kind: "original" as const },
      } : {}),
    }, { status: recoverable ? 503 : 500 });
  }
}
