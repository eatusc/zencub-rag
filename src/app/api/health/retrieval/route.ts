import { NextResponse } from "next/server";
import { openaiFor } from "@/lib/answerProviders";
import { getAppMode } from "@/lib/appMode";
import { getServerEnv } from "@/lib/env";
import { vectorResults } from "@/lib/ragPipeline";
import { CanaryMissingKeyError, runRetrievalCanary } from "@/lib/retrievalCanary";

export const dynamic = "force-dynamic";

// Runs a real embedding and vector search inside the serving process, so it
// tests the key that process actually loaded. Not logged to rag_search_logs: a
// probe every 5 minutes would bury the real traffic in that table.
export async function GET() {
  // Each call spends an embedding, so it exists only on the loopback MCP build.
  // Middleware already blocks it on public and instructors; this also keeps it
  // off the demo build, whose middleware is a PIN gate rather than an allowlist.
  if (getAppMode() !== "mcp") return new NextResponse(null, { status: 404 });

  const result = await runRetrievalCanary(async (query, limit) => {
    const env = getServerEnv();
    if (!env.openaiApiKey) throw new CanaryMissingKeyError();
    return vectorResults(query, limit, openaiFor(env), env);
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
