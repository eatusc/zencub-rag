import { createServerSupabase } from "@/lib/supabase";
import type { AnswerProvider } from "@/lib/providers";

export type SearchAction = "keyword" | "semantic" | "analyze" | "ask" | "follow_up";

type SearchLog = {
  query: string;
  action: SearchAction;
  provider?: AnswerProvider;
  retrieval?: "auto" | "text" | "vector" | "hybrid";
  metadata?: Record<string, string | number | boolean | null>;
};

/**
 * Persist a user-triggered search without allowing analytics to break the app.
 * This is awaited by routes so serverless runtimes cannot terminate before the
 * write is sent, but database errors are deliberately swallowed.
 */
export async function logSearch(entry: SearchLog): Promise<void> {
  try {
    const supabase = createServerSupabase();
    const payload = {
      query: entry.query,
      action: entry.action,
      provider: entry.provider ?? null,
      retrieval: entry.retrieval ?? null,
      metadata: entry.metadata ?? {},
    };
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
