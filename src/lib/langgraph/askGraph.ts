import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { AIMessageChunk } from "@langchain/core/messages";
import { getServerEnv } from "@/lib/env";
import {
  CANDIDATE_POOL,
  MAX_PER_VIDEO,
  RERANK_POOL,
  capPerVideo,
  enrichWithTechniques,
  filterDegenerate,
  rrfFuse,
} from "@/lib/ragRetrieval";
import { coerceAnswer, formatRagSource, type RagSource } from "@/lib/ragUtils";
import { createServerSupabase } from "@/lib/supabase";
import { refineResultTimestamps } from "@/lib/timestampRefinement";
import type { RagAnswer, RagGraphTraceEntry, RagSearchResult } from "@/lib/types";

// This module is the LangGraph twin of src/app/api/rag/ask/route.ts. It runs the
// *same* retrieval math (same Supabase RPCs, same RRF/diversity/rerank/generate
// stages, same answer contract) but wires the stages together as a LangGraph
// StateGraph and drives the LLM/embedding calls through LangChain runnables
// (ChatOpenAI / OpenAIEmbeddings) instead of the raw OpenAI SDK. Keeping the
// retrieval identical makes the two engines an apples-to-apples comparison; only
// the orchestration layer differs.

const RESULT_LIMIT = 8;
type RetrievalMode = "vector" | "text" | "hybrid";
export type RequestedRetrieval = "text" | "vector" | "auto";

const RERANK_SYSTEM = [
  "You rank transcript chunks by how well they answer the user's query.",
  "Judge intent, not just keyword overlap: a query about defending or escaping a technique should rank defensive chunks above offensive ones.",
  "Return valid JSON only: { \"order\": number[] } listing the provided indices from most to least relevant.",
  "Include every index exactly once.",
].join(" ");

const ANSWER_SYSTEM = [
  "You are a concise BJJ research assistant.",
  "Answer only from the provided transcript chunks.",
  "Do not invent techniques, videos, timestamps, or claims.",
  "Each source may include technique, position, difficulty, and gi_nogi tags; use them to frame the answer accurately.",
  "If evidence is weak, say so in caveats.",
  "Return valid JSON only with keys: answer, citations, key_takeaways, follow_up_searches, caveats.",
  "citations must be copied from provided sources and include title, citation, start_seconds, end_seconds, watch_url.",
  "If any source supports the answer, include at least one citation.",
  "Prefer citing 2 or more distinct videos when multiple sources support the answer, rather than repeating one video at different timestamps.",
  "Use short paragraphs and practical jiu-jitsu language.",
].join(" ");

// ---- Graph state ----------------------------------------------------------
// Arrays default to empty and are last-write-wins; the trace reducer appends so
// each node contributes one entry in execution order.
const replace = <T>(fallback: () => T) => ({ reducer: (_prev: T, next: T) => next, default: fallback });

const GraphState = Annotation.Root({
  query: Annotation<string>(),
  requestedRetrieval: Annotation<RequestedRetrieval>({ reducer: (_p, n) => n, default: () => "auto" as RequestedRetrieval }),
  vector: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  text: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  fused: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  retrieval: Annotation<RetrievalMode>({ reducer: (_p, n) => n, default: () => "hybrid" as RetrievalMode }),
  reranked: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  sources: Annotation<RagSource[]>(replace<RagSource[]>(() => [])),
  answer: Annotation<RagAnswer | null>({ reducer: (_p, n) => n, default: () => null }),
  trace: Annotation<RagGraphTraceEntry[]>({ reducer: (prev, next) => prev.concat(next), default: () => [] }),
});

type State = typeof GraphState.State;

function trace(node: string, label: string, detail: string, startedAt: number): RagGraphTraceEntry {
  return { node, label, detail, ms: Math.round(performance.now() - startedAt) };
}

// LangChain messages can carry string or structured content; flatten to text.
function messageText(message: AIMessageChunk): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

// ---- Retrieval helpers (same RPCs the classic route calls) ----------------
async function vectorResults(query: string, env: ReturnType<typeof getServerEnv>): Promise<RagSearchResult[]> {
  const embeddings = new OpenAIEmbeddings({ apiKey: env.openaiApiKey, model: env.ragEmbeddingModel });
  const queryEmbedding = await embeddings.embedQuery(query);

  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("match_rag_transcript_chunks", {
    query_embedding: queryEmbedding,
    match_count: CANDIDATE_POOL,
    filter_video_id: null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as RagSearchResult[]).map((result) => ({
    ...result,
    rank: result.similarity ?? result.rank ?? 0,
  }));
}

async function textResults(query: string): Promise<RagSearchResult[]> {
  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("search_rag_transcript_chunks", {
    query_text: query,
    match_count: CANDIDATE_POOL,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as RagSearchResult[];
}

// LangChain-driven reranker. Same prompt/contract as the classic rerankWithLLM,
// but the call goes through a ChatOpenAI runnable. Falls back to input order on
// any error so retrieval never hard-fails on the rerank step.
async function rerankWithChatModel(query: string, rows: RagSearchResult[], env: ReturnType<typeof getServerEnv>): Promise<RagSearchResult[]> {
  if (rows.length <= 1 || rows.length <= RESULT_LIMIT) return rows;

  try {
    const model = new ChatOpenAI({ apiKey: env.openaiApiKey, model: env.ragRerankModel, temperature: 0 });

    const docs = rows.map((row, index) => ({
      index,
      title: row.metadata?.video_title ?? row.video_id,
      snippet: row.text.replace(/\s+/g, " ").trim().slice(0, 400),
    }));

    const response = await model.invoke(
      [
        ["system", RERANK_SYSTEM],
        ["human", JSON.stringify({ query, documents: docs })],
      ],
      { response_format: { type: "json_object" } },
    );

    const parsed = safeParse(messageText(response as AIMessageChunk)) as { order?: unknown };
    if (!Array.isArray(parsed.order)) return rows;

    const seen = new Set<number>();
    const ordered: RagSearchResult[] = [];
    for (const value of parsed.order) {
      const index = typeof value === "number" ? value : Number(value);
      if (Number.isInteger(index) && index >= 0 && index < rows.length && !seen.has(index)) {
        seen.add(index);
        ordered.push(rows[index]);
      }
    }
    rows.forEach((row, index) => {
      if (!seen.has(index)) ordered.push(row);
    });
    return ordered;
  } catch {
    return rows;
  }
}

// ---- Nodes ----------------------------------------------------------------
async function retrieveNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const requested = state.requestedRetrieval;

  let vector: RagSearchResult[] = [];
  let text: RagSearchResult[] = [];

  if (requested === "text") {
    text = filterDegenerate(await textResults(state.query));
  } else if (requested === "vector") {
    vector = filterDegenerate(await vectorResults(state.query, env));
  } else {
    const [vectorRaw, textRaw] = await Promise.all([
      vectorResults(state.query, env).catch(() => [] as RagSearchResult[]),
      textResults(state.query),
    ]);
    vector = filterDegenerate(vectorRaw);
    text = filterDegenerate(textRaw);
  }

  return {
    vector,
    text,
    trace: [trace("retrieve", "Retrieve", `OpenAIEmbeddings + Supabase RPCs → vector ${vector.length}, text ${text.length} candidates`, startedAt)],
  };
}

function fuseNode(state: State): Partial<State> {
  const startedAt = performance.now();
  const { vector, text, requestedRetrieval } = state;

  let retrieval: RetrievalMode;
  let fused: RagSearchResult[];

  if (requestedRetrieval === "text") {
    retrieval = "text";
    fused = capPerVideo(text);
  } else if (requestedRetrieval === "vector") {
    retrieval = "vector";
    fused = capPerVideo(vector);
  } else if (vector.length === 0) {
    retrieval = "text";
    fused = capPerVideo(text);
  } else if (text.length === 0) {
    retrieval = "vector";
    fused = capPerVideo(vector);
  } else {
    retrieval = "hybrid";
    fused = capPerVideo(rrfFuse([vector, text]));
  }

  return {
    fused,
    retrieval,
    trace: [trace("fuse", "Fuse + Diversify", `${retrieval} · RRF → ${fused.length} candidates, capped ${MAX_PER_VIDEO}/video`, startedAt)],
  };
}

async function rerankNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const pool = state.fused.slice(0, RERANK_POOL);

  if (!env.ragRerankEnabled) {
    return { reranked: pool, trace: [trace("rerank", "Rerank", "skipped (RAG_RERANK=off)", startedAt)] };
  }

  const reranked = await rerankWithChatModel(state.query, pool, env);
  return {
    reranked,
    trace: [trace("rerank", "Rerank", `ChatOpenAI reordered ${pool.length} candidates by intent (${env.ragRerankModel})`, startedAt)],
  };
}

async function enrichNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const top = await refineResultTimestamps(state.query, state.reranked.slice(0, RESULT_LIMIT));
  const enriched = await enrichWithTechniques(top);
  const sources = enriched.map(({ row, technique }, index) => formatRagSource(row, index, technique));
  return {
    sources,
    trace: [trace("enrich", "Refine + Enrich", `${sources.length} sources: timestamp refinement + technique metadata`, startedAt)],
  };
}

async function generateNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const model = new ChatOpenAI({ apiKey: env.openaiApiKey, model: env.ragAnswerModel, temperature: 0.2 });

  const response = await model.invoke(
    [
      ["system", ANSWER_SYSTEM],
      ["human", JSON.stringify({
        query: state.query,
        task: "Answer the question using only these retrieved transcript chunks.",
        sources: state.sources,
      })],
    ],
    { response_format: { type: "json_object" } },
  );

  const answer = coerceAnswer(safeParse(messageText(response as AIMessageChunk)));
  return { answer, trace: [trace("generate", "Generate", `cited answer from ${state.sources.length} sources (${env.ragAnswerModel})`, startedAt)] };
}

// ---- Graph wiring ---------------------------------------------------------
// retrieve → fuse →(sources?)→ rerank → enrich → generate. If fusion yields no
// candidates we short-circuit to END and let the route return a 404, matching
// the classic route's "No sources found" behavior without a wasted LLM call.
function buildGraph() {
  return new StateGraph(GraphState)
    .addNode("retrieve", retrieveNode)
    .addNode("fuse", fuseNode)
    .addNode("rerank", rerankNode)
    .addNode("enrich", enrichNode)
    .addNode("generate", generateNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "fuse")
    .addConditionalEdges("fuse", (state: State) => (state.fused.length === 0 ? "empty" : "continue"), {
      empty: END,
      continue: "rerank",
    })
    .addEdge("rerank", "enrich")
    .addEdge("enrich", "generate")
    .addEdge("generate", END)
    .compile();
}

let compiled: ReturnType<typeof buildGraph> | null = null;
function getGraph() {
  if (!compiled) compiled = buildGraph();
  return compiled;
}

export type AskGraphResult = {
  retrieval: RetrievalMode;
  reranked: boolean;
  sources: RagSource[];
  answer: RagAnswer | null;
  trace: RagGraphTraceEntry[];
};

export async function runAskGraph(query: string, requestedRetrieval: RequestedRetrieval): Promise<AskGraphResult> {
  const env = getServerEnv();
  const final = await getGraph().invoke({ query, requestedRetrieval });
  return {
    retrieval: final.retrieval,
    reranked: env.ragRerankEnabled,
    sources: final.sources,
    answer: final.answer,
    trace: final.trace,
  };
}
