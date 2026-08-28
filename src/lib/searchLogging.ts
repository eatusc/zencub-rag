import { createServerSupabase } from "@/lib/supabase";
import type { AnswerProvider } from "@/lib/providers";

// "mcp" is retrieval served to the MCP server by /api/rag/retrieve. It is a
// distinct value so agent traffic is separable from people using
// search.zencub.com: before this existed, every MCP search wrote rows tagged
// "keyword" and "semantic", indistinguishable from real site visitors.
// Requires mcp/migrations/0003-search-log-mcp-action.sql, which widens the
// CHECK constraint on rag_search_logs.action. logSearch swallows database
// errors, so until that migration is applied these rows are dropped rather
// than written -- which is still strictly better than mislabelling them.
export type SearchAction = "keyword" | "semantic" | "analyze" | "ask" | "follow_up" | "mcp";

export type SearchOutcome = {
  success: boolean;
  statusCode: number;
  durationMs: number;
  resultCount: number;
  model?: string;
  errorCode?: string;
  citationRequestedCount?: number;
  citationVerifiedCount?: number;
  citationRejectedCount?: number;
  citationDuplicateCount?: number;
  citationTruncatedCount?: number;
  citationMissing?: boolean;
};

export type SearchLog = {
  query: string;
  action: SearchAction;
  provider?: AnswerProvider;
  retrieval?: "auto" | "text" | "vector" | "hybrid";
  requestedProvider?: AnswerProvider;
  requestedRetrieval?: "auto" | "text" | "vector";
  outcome?: SearchOutcome;
  metadata?: Record<string, string | number | boolean | null>;
};

export function buildSearchLogPayload(entry: SearchLog) {
  const outcomeMetadata = entry.outcome ? {
    success: entry.outcome.success,
    status_code: entry.outcome.statusCode,
    duration_ms: Math.max(0, Math.round(entry.outcome.durationMs)),
    result_count: Math.max(0, Math.round(entry.outcome.resultCount)),
    ...(entry.outcome.model ? { model: entry.outcome.model } : {}),
    ...(entry.outcome.errorCode ? { error_code: entry.outcome.errorCode } : {}),
    ...(entry.outcome.citationRequestedCount !== undefined
      ? { citation_requested_count: Math.max(0, Math.round(entry.outcome.citationRequestedCount)) }
      : {}),
    ...(entry.outcome.citationVerifiedCount !== undefined
      ? { citation_verified_count: Math.max(0, Math.round(entry.outcome.citationVerifiedCount)) }
      : {}),
    ...(entry.outcome.citationRejectedCount !== undefined
      ? {
        citation_rejected_count: Math.max(0, Math.round(entry.outcome.citationRejectedCount)),
      }
      : {}),
    ...(entry.outcome.citationDuplicateCount !== undefined
      ? { citation_duplicate_count: Math.max(0, Math.round(entry.outcome.citationDuplicateCount)) }
      : {}),
    ...(entry.outcome.citationTruncatedCount !== undefined
      ? { citation_truncated_count: Math.max(0, Math.round(entry.outcome.citationTruncatedCount)) }
      : {}),
    ...(entry.outcome.citationMissing !== undefined
      ? { citation_missing: entry.outcome.citationMissing }
      : {}),
    ...(
      entry.outcome.citationRejectedCount !== undefined || entry.outcome.citationMissing !== undefined
        ? {
          citation_validation_failed:
            (entry.outcome.citationRejectedCount ?? 0) > 0 || entry.outcome.citationMissing === true,
        }
        : {}
    ),
  } : {};

  return {
    query: entry.query,
    action: entry.action,
    // These columns describe what actually ran. Requested values remain in
    // metadata so provider fallback and retrieval fallback are measurable.
    provider: entry.provider ?? null,
    retrieval: entry.retrieval ?? null,
    metadata: {
      ...(entry.requestedProvider ? { requested_provider: entry.requestedProvider } : {}),
      ...(entry.requestedRetrieval ? { requested_retrieval: entry.requestedRetrieval } : {}),
      ...entry.metadata,
      ...outcomeMetadata,
    },
  };
}

/**
 * Persist a user-triggered search without allowing analytics to break the app.
 * This is awaited by routes so serverless runtimes cannot terminate before the
 * write is sent, but database errors are deliberately swallowed.
 */
export async function logSearch(entry: SearchLog): Promise<void> {
  try {
    const supabase = createServerSupabase();
    const payload = buildSearchLogPayload(entry);
    const { error } = await supabase
      .from("rag_search_logs")
      .insert(payload)
      .abortSignal(AbortSignal.timeout(2_000));

    // Preserve the search while an existing project is between the app deploy
    // and the provider-constraint migration. The requested provider remains in
    // metadata until the database accepts it in the dedicated column.
    if (error?.code === "23514" && entry.provider && error.message.includes("provider")) {
      const { error: fallbackError } = await supabase
        .from("rag_search_logs")
        .insert({
          ...payload,
          provider: null,
          metadata: {
            ...payload.metadata,
            answer_provider: entry.provider,
            provider_constraint_fallback: true,
          },
        })
        .abortSignal(AbortSignal.timeout(2_000));
      if (fallbackError) console.warn(`[search-log] ${fallbackError.message}`);
      return;
    }

    if (error) console.warn(`[search-log] ${error.message}`);
  } catch (error) {
    console.warn(`[search-log] ${error instanceof Error ? error.message : "Unknown logging error"}`);
  }
}
