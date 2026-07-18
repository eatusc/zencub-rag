import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import OpenAI from "openai";
import { getServerEnv } from "@/lib/env";
import {
  contextResults,
  metadataResults,
  rerankCandidates,
  textResults,
  uniqueRows,
  vectorResults,
  type RequestedRetrieval,
  type RetrievalMode,
} from "@/lib/ragPipeline";
import { CANDIDATE_POOL, capPerVideo, filterDegenerate, rrfFuse } from "@/lib/ragRetrieval";
import type { RagGraphTraceEntry, RagSearchResult } from "@/lib/types";
import { claimFailureInjection, logRecoveryExecution } from "@/lib/langgraph/testEvents";

const replace = <T>(fallback: () => T) => ({
  reducer: (_previous: T, next: T) => next,
  default: fallback,
});

const RetrievalState = Annotation.Root({
  query: Annotation<string>(),
  requestedRetrieval: Annotation<RequestedRetrieval>({ reducer: (_p, n) => n, default: () => "auto" }),
  keepPrior: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  contextIds: Annotation<string[]>(replace<string[]>(() => [])),
  testThreadId: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  testFailure: Annotation<"rerank_once" | null>({ reducer: (_p, n) => n, default: () => null }),
  vector: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  keyword: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  metadata: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  prior: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  retrieval: Annotation<RetrievalMode>({ reducer: (_p, n) => n, default: () => "hybrid" }),
  candidates: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  reranked: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  didRerank: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  trace: Annotation<RagGraphTraceEntry[]>({ reducer: (previous, next) => previous.concat(next), default: () => [] }),
});

type State = typeof RetrievalState.State;

function trace(node: string, label: string, detail: string, startedAt: number): RagGraphTraceEntry {
  return { node, label, detail, ms: Math.round(performance.now() - startedAt) };
}

async function vectorNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  if (state.testFailure && state.testThreadId) await logRecoveryExecution(state.testThreadId, "vector");
  if (state.requestedRetrieval === "text") {
    return { vector: [], trace: [trace("retrieve_vector", "Vector search", "disabled by retrieval mode", startedAt)] };
  }
  const env = getServerEnv();
  if (!env.openaiApiKey) {
    return { vector: [], trace: [trace("retrieve_vector", "Vector search", "unavailable without OPENAI_API_KEY", startedAt)] };
  }
  try {
    const openai = new OpenAI({ apiKey: env.openaiApiKey });
    const rows = filterDegenerate(await vectorResults(state.query, CANDIDATE_POOL, openai, env));
    return { vector: rows, trace: [trace("retrieve_vector", "Vector search", `${rows.length} semantic candidates`, startedAt)] };
  } catch (error) {
    return { vector: [], trace: [trace("retrieve_vector", "Vector search", `failed safely: ${error instanceof Error ? error.message : "unknown error"}`, startedAt)] };
  }
}

async function keywordNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  if (state.testFailure && state.testThreadId) await logRecoveryExecution(state.testThreadId, "keyword");
  if (state.requestedRetrieval === "vector") {
    return { keyword: [], trace: [trace("retrieve_keyword", "Keyword search", "disabled by retrieval mode", startedAt)] };
  }
  try {
    const rows = filterDegenerate(await textResults(state.query, CANDIDATE_POOL));
    return { keyword: rows, trace: [trace("retrieve_keyword", "Keyword search", `${rows.length} full-text candidates`, startedAt)] };
  } catch (error) {
    return { keyword: [], trace: [trace("retrieve_keyword", "Keyword search", `failed safely: ${error instanceof Error ? error.message : "unknown error"}`, startedAt)] };
  }
}

async function metadataNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  if (state.testFailure && state.testThreadId) await logRecoveryExecution(state.testThreadId, "metadata");
  if (state.requestedRetrieval === "vector") {
    return { metadata: [], trace: [trace("retrieve_metadata", "Metadata search", "disabled by retrieval mode", startedAt)] };
  }
  try {
    const rows = filterDegenerate(await metadataResults(state.query, CANDIDATE_POOL));
    return { metadata: rows, trace: [trace("retrieve_metadata", "Metadata search", `${rows.length} technique/position candidates`, startedAt)] };
  } catch (error) {
    return { metadata: [], trace: [trace("retrieve_metadata", "Metadata search", `failed safely: ${error instanceof Error ? error.message : "unknown error"}`, startedAt)] };
  }
}

async function priorContextNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  if (state.testFailure && state.testThreadId) await logRecoveryExecution(state.testThreadId, "context");
  if (!state.keepPrior || state.contextIds.length === 0) {
    return { prior: [], trace: [trace("retrieve_context", "Prior context", "fresh topic; no prior sources loaded", startedAt)] };
  }
  try {
    const rows = await contextResults(state.contextIds);
    return { prior: rows, trace: [trace("retrieve_context", "Prior context", `${rows.length} checkpointed sources loaded`, startedAt)] };
  } catch (error) {
    return { prior: [], trace: [trace("retrieve_context", "Prior context", `failed safely: ${error instanceof Error ? error.message : "unknown error"}`, startedAt)] };
  }
}

export function fuseRetrievalResults(input: Pick<State, "vector" | "keyword" | "metadata" | "prior">): {
  retrieval: RetrievalMode;
  candidates: RagSearchResult[];
} {
  const available = [
    { mode: "vector" as const, rows: input.vector },
    { mode: "text" as const, rows: input.keyword },
    { mode: "metadata" as const, rows: input.metadata },
  ].filter((entry) => entry.rows.length > 0);
  const retrieval: RetrievalMode = available.length === 1 ? available[0].mode : "hybrid";
  const fresh = available.length === 0
    ? []
    : available.length === 1
      ? available[0].rows
      : rrfFuse(available.map((entry) => entry.rows));
  return {
    retrieval,
    candidates: capPerVideo(filterDegenerate(uniqueRows([...input.prior, ...fresh]))),
  };
}

async function fuseNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  if (state.testFailure && state.testThreadId) await logRecoveryExecution(state.testThreadId, "fuse");
  const result = fuseRetrievalResults(state);
  return {
    ...result,
    trace: [trace(
      "retrieve_fuse",
      "Fuse retrieval",
      `${result.retrieval} · vector ${state.vector.length}, keyword ${state.keyword.length}, metadata ${state.metadata.length}, prior ${state.prior.length} → ${result.candidates.length}`,
      startedAt,
    )],
  };
}

async function rerankNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  if (state.testFailure && state.testThreadId) {
    await logRecoveryExecution(state.testThreadId, "rerank");
    if (state.testFailure === "rerank_once" && await claimFailureInjection(state.testThreadId, "rerank")) {
      throw new Error("LANGGRAPH_TEST_FAILURE: rerank_once");
    }
  }
  const env = getServerEnv();
  const openai = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  const { reranked, didRerank } = await rerankCandidates(state.query, state.candidates, openai, env);
  return {
    reranked,
    didRerank,
    trace: [trace("retrieve_rerank", "Rerank evidence", didRerank ? `${reranked.length} candidates ranked by intent` : "preserved fused order", startedAt)],
  };
}

const retrievalSubgraph = new StateGraph(RetrievalState)
  .addNode("vector_search", vectorNode)
  .addNode("keyword_search", keywordNode)
  .addNode("metadata_search", metadataNode)
  .addNode("prior_context", priorContextNode)
  .addNode("fuse", fuseNode)
  .addNode("rerank", rerankNode)
  .addEdge(START, "vector_search")
  .addEdge(START, "keyword_search")
  .addEdge(START, "metadata_search")
  .addEdge(START, "prior_context")
  .addEdge(["vector_search", "keyword_search", "metadata_search", "prior_context"], "fuse")
  .addEdge("fuse", "rerank")
  .addEdge("rerank", END)
  .compile()
  .withConfig({ runName: "retrieval_subgraph" });

export type RetrievalSubgraphResult = {
  retrieval: RetrievalMode;
  reranked: RagSearchResult[];
  didRerank: boolean;
  trace: RagGraphTraceEntry[];
};

export async function runRetrievalSubgraph(input: {
  query: string;
  requestedRetrieval?: RequestedRetrieval;
  keepPrior: boolean;
  contextIds: string[];
  testThreadId?: string;
  testFailure?: "rerank_once" | null;
}, config?: RunnableConfig): Promise<RetrievalSubgraphResult> {
  const result = await retrievalSubgraph.invoke({
    query: input.query,
    requestedRetrieval: input.requestedRetrieval ?? "auto",
    keepPrior: input.keepPrior,
    contextIds: input.contextIds,
    testThreadId: input.testThreadId ?? "",
    testFailure: input.testFailure ?? null,
  }, config);
  return {
    retrieval: result.retrieval,
    reranked: result.reranked,
    didRerank: result.didRerank,
    trace: result.trace,
  };
}
