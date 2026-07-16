import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { generateAnswer, probeQwen, providerModel } from "@/lib/answerProviders";
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
  const requestedProvider = normalizeProvider(body.provider);
  const conversation = normalizeConversation(body.conversation);
  const contextIds = normalizeContextIds(body.context_ids);

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }
  if (query.length > 1_000) {
    return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });
  }

  await logSearch({
    query,
    action: conversation.length > 0 ? "follow_up" : "ask",
    provider: requestedProvider,
    retrieval: requestedRetrieval,
    metadata: {
      conversation_turns: conversation.length,
      retained_context_sources: contextIds.length,
    },
  });

  try {
    const env = getServerEnv();
    const hasOpenai = Boolean(env.openaiApiKey);
    const hasOpenRouter = Boolean(env.openRouterApiKey);

    // Resolve the answer provider: honor an explicit request, otherwise default
    // to the local Qwen model when it's reachable (the Mac Studio), else OpenAI.
    let provider: AnswerProvider = requestedProvider
      ?? ((await probeQwen(env)) ? "qwen" : hasOpenRouter ? "openrouter" : "openai");
    if (provider === "openrouter" && !hasOpenRouter) {
      return NextResponse.json({ error: "Missing OPENROUTER_API_KEY." }, { status: 500 });
    }
    if (provider === "openai" && !hasOpenai) {
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
    const candidates = capPerVideo(filterDegenerate(uniqueRows([...priorRows, ...rows])));

    if (candidates.length === 0) {
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
        generation = await generateAnswer(fallback, query, sources, env, openai, conversation);
      } else {
        throw genError;
      }
    }

    return NextResponse.json({
      query,
      provider,
      model: providerModel(provider, env),
      retrieval,
      reranked: didRerank,
      source_count: sources.length,
      context_ids: top.map((row) => row.id),
      usage: generation.usage,
      answer: generation.answer,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
