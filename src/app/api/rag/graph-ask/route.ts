import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { runAskGraph, type RequestedRetrieval } from "@/lib/langgraph/askGraph";
import type { RagGraphAskResponse } from "@/lib/types";

// LangGraph counterpart to /api/rag/ask. Same corpus, same retrieval, but the
// pipeline is orchestrated as a LangGraph StateGraph and returns the executed
// node trace + timing so the UI can compare it against the classic engine.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { query?: unknown; retrieval?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedRetrieval: RequestedRetrieval =
    body.retrieval === "text" || body.retrieval === "vector" ? body.retrieval : "auto";

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }

  try {
    const env = getServerEnv();
    if (!env.openaiApiKey) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    const startedAt = performance.now();
    const result = await runAskGraph(query, requestedRetrieval);

    if (result.sources.length === 0 || !result.answer) {
      return NextResponse.json({ error: "No sources found to answer from." }, { status: 404 });
    }

    const response: RagGraphAskResponse = {
      query,
      engine: "langgraph",
      model: env.ragAnswerModel,
      retrieval: result.retrieval,
      reranked: result.reranked,
      source_count: result.sources.length,
      answer: result.answer,
      trace: result.trace,
      total_ms: Math.round(performance.now() - startedAt),
    };

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
