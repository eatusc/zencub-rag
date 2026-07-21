import { createServerSupabase } from "@/lib/supabase";
import type { AnswerProvider } from "@/lib/providers";
import type { RagInstructorCompareResponse, RagStoredInstructorCompareRun } from "@/lib/types";

type StoredRow = {
  id: string;
  created_at: string;
  result: unknown;
};

function storedRun(row: StoredRow): RagStoredInstructorCompareRun | null {
  if (!row.result || typeof row.result !== "object") return null;
  const result = row.result as RagInstructorCompareResponse;
  if (result.engine !== "langgraph" || typeof result.thread_id !== "string" || !result.comparison) return null;
  return { ...result, stored_run_id: row.id, stored_at: row.created_at };
}

export async function storeInstructorCompareRun(result: RagInstructorCompareResponse): Promise<RagStoredInstructorCompareRun> {
  const { session_token: _sessionToken, ...safeResult } = result;
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_instructor_compare_runs")
    .insert({
      thread_id: result.thread_id,
      query: result.query,
      provider: result.provider,
      model: result.model,
      instructor_count: result.instructor_count,
      evidence_count: result.evidence_count,
      total_ms: result.total_ms,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      total_tokens: result.usage.total_tokens,
      shared_principle_count: result.comparison.shared_principles.length,
      difference_count: result.comparison.important_differences.length,
      turn_index: result.session.turn_index,
      relationship: result.session.relationship,
      parent_thread_id: result.session.parent_thread_id,
      result: safeResult,
    })
    .select("id,created_at,result")
    .single();
  if (error) throw new Error(`Instructor comparison storage failed: ${error.message}`);
  const run = storedRun(data as StoredRow);
  if (!run) throw new Error("Instructor comparison storage returned an invalid result.");
  return run;
}

export async function listInstructorCompareRuns(input: {
  limit: number;
  offset: number;
  provider?: Exclude<AnswerProvider, "claude">;
}): Promise<{ runs: RagStoredInstructorCompareRun[]; total: number }> {
  const supabase = createServerSupabase();
  let query = supabase
    .from("rag_instructor_compare_runs")
    .select("id,created_at,result", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);
  if (input.provider) query = query.eq("provider", input.provider);
  const { data, error, count } = await query;
  if (error) throw new Error(`Instructor comparison history failed: ${error.message}`);
  return {
    runs: ((data ?? []) as StoredRow[]).flatMap((row) => {
      const run = storedRun(row);
      return run ? [run] : [];
    }),
    total: count ?? 0,
  };
}
