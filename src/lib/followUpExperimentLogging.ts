import { createServerSupabase } from "@/lib/supabase";
import type { AnswerProvider } from "@/lib/providers";
import type { RagGraphTraceEntry } from "@/lib/types";

export type FollowUpExperimentLog = {
  threadId: string;
  turnIndex: number;
  query: string;
  requestedProvider: AnswerProvider;
  actualProvider?: AnswerProvider;
  model?: string;
  relationship?: "same_topic" | "new_topic";
  retrieval?: "text" | "vector" | "metadata" | "hybrid";
  sourceCount?: number;
  conversationTurns: number;
  retainedContextSources: number;
  durationMs?: number;
  trace?: RagGraphTraceEntry[];
  success: boolean;
  errorCode?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

/**
 * Experiment logging must never break a follow-up. This also lets the app and
 * migration deploy independently: a missing table is reported only in logs.
 */
export async function logFollowUpExperiment(entry: FollowUpExperimentLog): Promise<void> {
  try {
    const supabase = createServerSupabase();
    const { error } = await supabase
      .from("rag_followup_experiment_runs")
      .insert({
        thread_id: entry.threadId,
        turn_index: entry.turnIndex,
        query: entry.query,
        requested_provider: entry.requestedProvider,
        actual_provider: entry.actualProvider ?? null,
        model: entry.model ?? null,
        relationship: entry.relationship ?? null,
        retrieval: entry.retrieval ?? null,
        source_count: entry.sourceCount ?? 0,
        conversation_turns: entry.conversationTurns,
        retained_context_sources: entry.retainedContextSources,
        duration_ms: entry.durationMs ?? null,
        trace: entry.trace ?? [],
        success: entry.success,
        error_code: entry.errorCode ?? null,
        metadata: entry.metadata ?? {},
      })
      .abortSignal(AbortSignal.timeout(2_000));

    if (error) console.warn(`[follow-up-experiment-log] ${error.message}`);
  } catch (error) {
    console.warn(
      `[follow-up-experiment-log] ${error instanceof Error ? error.message : "Unknown logging error"}`,
    );
  }
}
