import { NextRequest, NextResponse } from "next/server";
import { probeQwen, providerModel } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { runInstructorComparison } from "@/lib/langgraph/instructorCompareGraph";
import { normalizeProvider } from "@/lib/providers";
import { logSearch } from "@/lib/searchLogging";
import type { RagInstructorCompareResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { query?: unknown; instructor_count?: unknown; provider?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const requestedCount = Number(body.instructor_count);
  const instructorCount = Number.isInteger(requestedCount) ? Math.min(Math.max(requestedCount, 2), 5) : 3;
  if (query.length < 2) return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  if (query.length > 1_000) return NextResponse.json({ error: "Query must be 1,000 characters or fewer." }, { status: 400 });

  const env = getServerEnv();
  const normalized = body.provider === undefined ? "openrouter" : normalizeProvider(body.provider);
  if (!normalized || normalized === "claude") {
    return NextResponse.json({ error: "Instructor Compare supports qwen, openrouter, or openai." }, { status: 400 });
  }
  const provider = normalized;
  if (provider === "qwen" && !await probeQwen(env)) {
    return NextResponse.json({ error: `Local Qwen model ${env.ragQwenModel} is not currently available.` }, { status: 503 });
  }
  if (provider === "openrouter" && !env.openRouterApiKey) {
    return NextResponse.json({ error: "Qwen3 235B requires OPENROUTER_API_KEY." }, { status: 503 });
  }
  if (provider === "openai" && !env.openaiApiKey) {
    return NextResponse.json({ error: "GPT-4o Mini requires OPENAI_API_KEY." }, { status: 503 });
  }
  const threadId = crypto.randomUUID();
  await logSearch({
    query,
    action: "ask",
    provider,
    retrieval: "hybrid",
    metadata: { workflow: "instructor_compare", requested_instructors: instructorCount, zero_paid_model_mode: provider === "qwen" },
  });

  const startedAt = performance.now();
  try {
    const result = await runInstructorComparison({ threadId, query, instructorCount, provider });
    const model = providerModel(provider, env);
    const response: RagInstructorCompareResponse = {
      query,
      engine: "langgraph",
      thread_id: threadId,
      provider,
      model,
      models: {
        semantic_embedding: provider === "qwen" ? null : env.openaiApiKey ? env.ragEmbeddingModel : null,
        evidence_reranker: result.rerank_applied ? model : null,
        instructor_analysis: model,
        synthesis: model,
      },
      zero_paid_model_mode: provider === "qwen",
      ...result,
      total_ms: Math.round(performance.now() - startedAt),
    };
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown comparison error";
    return NextResponse.json({ error: message.replace(/^INSUFFICIENT_INSTRUCTORS:\s*/, ""), thread_id: threadId }, {
      status: message.startsWith("INSUFFICIENT_INSTRUCTORS") ? 422 : 500,
    });
  }
}
