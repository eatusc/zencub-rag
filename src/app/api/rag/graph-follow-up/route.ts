import { NextRequest, NextResponse } from "next/server";
import { probeQwen } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { logFollowUpExperiment } from "@/lib/followUpExperimentLogging";
import { runExperimentalFollowUp } from "@/lib/langgraph/followUpGraph";
import { normalizeProvider, type AnswerProvider } from "@/lib/providers";
import { normalizeContextIds, normalizeConversation } from "@/lib/ragPipeline";
import { logSearch } from "@/lib/searchLogging";
import type { RagExperimentalFollowUpResponse } from "@/lib/types";

function normalizeThreadId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

function normalizeTurnIndex(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 1;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    query?: unknown;
    provider?: unknown;
    conversation?: unknown;
    context_ids?: unknown;
    thread_id?: unknown;
    turn_index?: unknown;
  };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedProvider = normalizeProvider(body.provider);
  const conversation = normalizeConversation(body.conversation);
  const contextIds = normalizeContextIds(body.context_ids);
  const threadId = normalizeThreadId(body.thread_id);
  const turnIndex = normalizeTurnIndex(body.turn_index);

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }
  if (query.length > 1_000) {
    return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });
  }
  if (conversation.length === 0) {
    return NextResponse.json({ error: "The experimental graph is only available for follow-up questions." }, { status: 400 });
  }

  const env = getServerEnv();
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
      conversation_turns: conversation.length,
      retained_context_sources: contextIds.length,
      experiment_turn: turnIndex,
    },
  });

  const startedAt = performance.now();
  try {
    const result = await runExperimentalFollowUp({ query, provider, conversation, contextIds });
    const totalMs = Math.round(performance.now() - startedAt);
    if (!result.answer || !result.provider || result.sources.length === 0) {
      await logFollowUpExperiment({
        threadId,
        turnIndex,
        query,
        requestedProvider: provider,
        relationship: result.relationship,
        retrieval: result.retrieval,
        sourceCount: result.sources.length,
        conversationTurns: conversation.length,
        retainedContextSources: contextIds.length,
        durationMs: totalMs,
        trace: result.trace,
        success: false,
        errorCode: "no_sources",
      });
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    const response: RagExperimentalFollowUpResponse = {
      query,
      engine: "langgraph",
      thread_id: threadId,
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
    };

    await logFollowUpExperiment({
      threadId,
      turnIndex,
      query,
      requestedProvider: provider,
      actualProvider: result.provider,
      model: result.model,
      relationship: result.relationship,
      retrieval: result.retrieval,
      sourceCount: result.sources.length,
      conversationTurns: conversation.length,
      retainedContextSources: contextIds.length,
      durationMs: totalMs,
      trace: result.trace,
      success: true,
      metadata: { reranked: result.reranked },
    });

    return NextResponse.json(response);
  } catch (error) {
    const totalMs = Math.round(performance.now() - startedAt);
    await logFollowUpExperiment({
      threadId,
      turnIndex,
      query,
      requestedProvider: provider,
      conversationTurns: conversation.length,
      retainedContextSources: contextIds.length,
      durationMs: totalMs,
      success: false,
      errorCode: "graph_error",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

