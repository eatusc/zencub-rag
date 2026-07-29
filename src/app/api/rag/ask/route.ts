import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { generateAnswer, probeQwen, providerModel } from "@/lib/answerProviders";
import { isPublicMode, publicAskProvider } from "@/lib/appMode";
import { getServerEnv } from "@/lib/env";
import { normalizeProvider, type AnswerProvider } from "@/lib/providers";
import {
  buildCandidates,
  contextResults,
  enrichCandidates,
  normalizeContextIds,
  normalizeConversation,
  rerankCandidates,
  uniqueRows,
} from "@/lib/ragPipeline";
import { capPerVideo, filterDegenerate } from "@/lib/ragRetrieval";
import { validateAnswerCitations } from "@/lib/ragUtils";
import { logSearch } from "@/lib/searchLogging";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as {
    query?: unknown;
    retrieval?: unknown;
    provider?: unknown;
    conversation?: unknown;
    context_ids?: unknown;
  };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedRetrieval = body.retrieval === "text" || body.retrieval === "vector" ? body.retrieval : "auto";
  // On the public deployment the caller does not get to pick the model: "claude"
  // spawns a CLI process per request and "openai" spends money. Anonymous
  // traffic gets whatever the server configured, never what the body asked for.
  const requestedProvider = isPublicMode()
    ? normalizeProvider(publicAskProvider())
    : normalizeProvider(body.provider);
  const conversation = normalizeConversation(body.conversation);
  const contextIds = normalizeContextIds(body.context_ids);

  const startedAt = performance.now();
  // `resolvedProvider` is the provider this request chose before any fallback,
  // including the auto-detected one. Without it a fallback is invisible whenever
  // the caller did not name a provider, which is every request on the demo
  // surface and any public deployment that leaves RAG_PUBLIC_ASK_PROVIDER unset.
  let resolvedProvider: AnswerProvider | undefined = requestedProvider;
  let actualProvider: AnswerProvider | undefined = requestedProvider;
  let actualRetrieval: "text" | "vector" | "hybrid" | undefined;
  const recordOutcome = async (outcome: {
    success: boolean;
    statusCode: number;
    resultCount: number;
    model?: string;
    errorCode?: string;
    citationRequestedCount?: number;
    citationVerifiedCount?: number;
    citationRejectedCount?: number;
    citationDuplicateCount?: number;
    citationTruncatedCount?: number;
    citationMissing?: boolean;
  }) => logSearch({
    // rag_search_logs.query requires at least 2 characters and stores the text
    // as-is, so an over-long rejected query is trimmed to the accepted maximum.
    query: query.slice(0, 1_000),
    action: conversation.length > 0 ? "follow_up" : "ask",
    ...(actualProvider ? { provider: actualProvider } : {}),
    ...(actualRetrieval ? { retrieval: actualRetrieval } : {}),
    ...(requestedProvider ? { requestedProvider } : {}),
    requestedRetrieval,
    outcome: {
      ...outcome,
      durationMs: performance.now() - startedAt,
    },
    metadata: {
      conversation_turns: conversation.length,
      retained_context_sources: contextIds.length,
      ...(resolvedProvider ? { resolved_provider: resolvedProvider } : {}),
      provider_fallback: Boolean(resolvedProvider && actualProvider && actualProvider !== resolvedProvider),
    },
  });

  // A query under two characters cannot be written to rag_search_logs at all,
  // so only the over-long rejection is measurable here.
  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }
  if (query.length > 1_000) {
    await recordOutcome({
      success: false,
      statusCode: 400,
      resultCount: 0,
      errorCode: "query_too_long",
    });
    return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });
  }

  try {
    const env = getServerEnv();
    const hasOpenai = Boolean(env.openaiApiKey);
    const hasOpenRouter = Boolean(env.openRouterApiKey);

    // Resolve the answer provider: honor an explicit request, otherwise default
    // to the local Qwen model when it's reachable (the Mac Studio), else OpenAI.
    let provider: AnswerProvider = requestedProvider
      ?? ((await probeQwen(env)) ? "qwen" : hasOpenRouter ? "openrouter" : "openai");
    resolvedProvider = provider;
    actualProvider = provider;
    if (provider === "openrouter" && !hasOpenRouter) {
      await recordOutcome({
        success: false,
        statusCode: 500,
        resultCount: 0,
        errorCode: "missing_openrouter_key",
      });
      return NextResponse.json({ error: "Missing OPENROUTER_API_KEY." }, { status: 500 });
    }
    if (provider === "openai" && !hasOpenai) {
      await recordOutcome({
        success: false,
        statusCode: 500,
        resultCount: 0,
        errorCode: "missing_openai_key",
      });
      return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    // Retrieval (embeddings + rerank) always runs on OpenAI; the provider choice
    // only swaps the model that writes the final answer. Without an OpenAI key we
    // degrade to text-only search and skip reranking so local providers still work.
    const openai = hasOpenai ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
    const retrievalQuery = conversation.length > 0
      ? [...conversation.map((turn) => turn.question), query].join(" | ").slice(0, 2_000)
      : query;
    const [{ retrieval, rows }, priorRows] = await Promise.all([
      buildCandidates(retrievalQuery, openai ? requestedRetrieval : "text", openai, env),
      contextResults(contextIds),
    ]);
    actualRetrieval = retrieval === "metadata" ? "hybrid" : retrieval;
    const candidates = capPerVideo(filterDegenerate(uniqueRows([...priorRows, ...rows])));

    if (candidates.length === 0) {
      await recordOutcome({
        success: false,
        statusCode: 404,
        resultCount: 0,
        errorCode: "no_sources",
      });
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    // Rerank the diverse candidate pool for true relevance, keep the top slice,
    // then enrich with overlapping technique metadata for grounded citations.
    const { reranked, didRerank } = await rerankCandidates(retrievalQuery, candidates, openai, env);
    const { top, sources } = await enrichCandidates(query, reranked);

    let generation;
    try {
      generation = await generateAnswer(provider, query, sources, env, openai, conversation);
    } catch (genError) {
      // Follow the answer-engine order for a transparent server-side fallback.
      const fallback: AnswerProvider | null = provider !== "openrouter" && hasOpenRouter
        ? "openrouter"
        : provider !== "openai" && hasOpenai
          ? "openai"
          : null;
      if (fallback) {
        provider = fallback;
        actualProvider = fallback;
        generation = await generateAnswer(fallback, query, sources, env, openai, conversation);
      } else {
        throw genError;
      }
    }
    const resolved = validateAnswerCitations(generation.answer, sources);
    const model = providerModel(provider, env);
    await recordOutcome({
      success: true,
      statusCode: 200,
      resultCount: sources.length,
      model,
      citationRequestedCount: resolved.validation.requested,
      citationVerifiedCount: resolved.validation.verified,
      citationRejectedCount: resolved.validation.rejected,
      citationDuplicateCount: resolved.validation.duplicates,
      citationTruncatedCount: resolved.validation.truncated,
      citationMissing: resolved.validation.missing,
    });

    return NextResponse.json({
      query,
      provider,
      model,
      retrieval,
      reranked: didRerank,
      source_count: sources.length,
      context_ids: top.map((row) => row.id),
      usage: generation.usage,
      answer: resolved.answer,
    });
  } catch (error) {
    await recordOutcome({
      success: false,
      statusCode: 500,
      resultCount: 0,
      errorCode: "ask_failed",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
