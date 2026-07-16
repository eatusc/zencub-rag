import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { generateAnswer, providerModel } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import type { AnswerProvider } from "@/lib/providers";
import {
  buildCandidates,
  contextResults,
  enrichCandidates,
  rerankCandidates,
  uniqueRows,
  type RetrievalMode,
} from "@/lib/ragPipeline";
import { capPerVideo, filterDegenerate } from "@/lib/ragRetrieval";
import type { RagSource } from "@/lib/ragUtils";
import type {
  RagAnswer,
  RagConversationTurn,
  RagGraphTraceEntry,
  RagSearchResult,
  RagTokenUsage,
} from "@/lib/types";

type Relationship = "same_topic" | "new_topic";

const replace = <T>(fallback: () => T) => ({
  reducer: (_previous: T, next: T) => next,
  default: fallback,
});

const FollowUpState = Annotation.Root({
  query: Annotation<string>(),
  requestedProvider: Annotation<AnswerProvider>(),
  conversation: Annotation<RagConversationTurn[]>(replace<RagConversationTurn[]>(() => [])),
  contextIds: Annotation<string[]>(replace<string[]>(() => [])),
  retrievalQuery: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  relationship: Annotation<Relationship>({ reducer: (_p, n) => n, default: () => "same_topic" }),
  retrieval: Annotation<RetrievalMode>({ reducer: (_p, n) => n, default: () => "hybrid" }),
  candidates: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  reranked: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  didRerank: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  sources: Annotation<RagSource[]>(replace<RagSource[]>(() => [])),
  contextIdsOut: Annotation<string[]>(replace<string[]>(() => [])),
  actualProvider: Annotation<AnswerProvider | null>({ reducer: (_p, n) => n, default: () => null }),
  model: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  usage: Annotation<RagTokenUsage | null>({ reducer: (_p, n) => n, default: () => null }),
  answer: Annotation<RagAnswer | null>({ reducer: (_p, n) => n, default: () => null }),
  trace: Annotation<RagGraphTraceEntry[]>({ reducer: (previous, next) => previous.concat(next), default: () => [] }),
});

type State = typeof FollowUpState.State;

function trace(node: string, label: string, detail: string, startedAt: number): RagGraphTraceEntry {
  return { node, label, detail, ms: Math.round(performance.now() - startedAt) };
}

function messageText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text);
      }
      return "";
    })
    .join("");
}

function fallbackRetrievalQuery(query: string, conversation: RagConversationTurn[]): string {
  return [...conversation.map((turn) => turn.question), query].join(" | ").slice(0, 2_000);
}

async function contextualizeNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const fallback = fallbackRetrievalQuery(state.query, state.conversation);

  if (!env.openaiApiKey || state.conversation.length === 0) {
    return {
      retrievalQuery: fallback || state.query,
      relationship: "same_topic",
      trace: [trace("contextualize", "Understand follow-up", "Used conversation questions directly (no rewrite model)", startedAt)],
    };
  }

  try {
    const model = new ChatOpenAI({
      apiKey: env.openaiApiKey,
      model: env.ragRerankModel,
      temperature: 0,
    });
    const recentConversation = state.conversation.slice(-3).map((turn) => ({
      question: turn.question,
      answer: turn.answer.slice(0, 1_200),
    }));
    const response = await model.invoke(
      [
        [
          "system",
          [
            "Turn the latest follow-up into a concise standalone BJJ search query.",
            "Also classify it as same_topic when prior transcript sources should remain useful, or new_topic when the user clearly changed subjects.",
            "Return JSON only: {\"standalone_query\": string, \"relationship\": \"same_topic\" | \"new_topic\"}.",
          ].join(" "),
        ],
        ["human", JSON.stringify({ conversation: recentConversation, latest_question: state.query })],
      ],
      { response_format: { type: "json_object" } },
    );
    const parsed = JSON.parse(messageText(response) || "{}") as {
      standalone_query?: unknown;
      relationship?: unknown;
    };
    const standalone = typeof parsed.standalone_query === "string"
      ? parsed.standalone_query.trim().slice(0, 2_000)
      : "";
    const relationship: Relationship = parsed.relationship === "new_topic" ? "new_topic" : "same_topic";
    return {
      retrievalQuery: standalone.length >= 2 ? standalone : fallback,
      relationship,
      trace: [trace(
        "contextualize",
        "Understand follow-up",
        `${relationship === "same_topic" ? "continued topic" : "new topic"} · rewrote as a standalone search`,
        startedAt,
      )],
    };
  } catch {
    return {
      retrievalQuery: fallback,
      relationship: "same_topic",
      trace: [trace("contextualize", "Understand follow-up", "Rewrite failed safely; retained conversation context", startedAt)],
    };
  }
}

async function retrieveNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const openai = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  const keepPrior = state.relationship === "same_topic";
  const [{ retrieval, rows }, priorRows] = await Promise.all([
    buildCandidates(state.retrievalQuery, openai ? "auto" : "text", openai, env),
    keepPrior ? contextResults(state.contextIds) : Promise.resolve([]),
  ]);
  const candidates = capPerVideo(filterDegenerate(uniqueRows([...priorRows, ...rows])));
  return {
    retrieval,
    candidates,
    trace: [trace(
      "retrieve",
      "Retrieve evidence",
      `${retrieval} · ${candidates.length} candidates · ${keepPrior ? `${priorRows.length} prior sources considered` : "fresh context"}`,
      startedAt,
    )],
  };
}

async function rerankNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const openai = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  const { reranked, didRerank } = await rerankCandidates(
    state.retrievalQuery,
    state.candidates,
    openai,
    env,
  );
  return {
    reranked,
    didRerank,
    trace: [trace(
      "rerank",
      "Rank evidence",
      didRerank ? `${reranked.length} candidates ranked by intent` : "Reranking unavailable; preserved retrieval order",
      startedAt,
    )],
  };
}

async function enrichNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const { top, sources } = await enrichCandidates(state.query, state.reranked);
  return {
    sources,
    contextIdsOut: top.map((row) => row.id),
    trace: [trace("enrich", "Prepare sources", `${sources.length} cited transcript moments with refined timestamps`, startedAt)],
  };
}

async function generateNode(state: State): Promise<Partial<State>> {
  const startedAt = performance.now();
  const env = getServerEnv();
  const openai = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  const generationConversation = state.relationship === "same_topic" ? state.conversation : [];
  let actualProvider = state.requestedProvider;
  let generation;

  try {
    generation = await generateAnswer(
      actualProvider,
      state.query,
      state.sources,
      env,
      openai,
      generationConversation,
    );
  } catch (generationError) {
    const fallback: AnswerProvider | null = actualProvider !== "openrouter" && env.openRouterApiKey
      ? "openrouter"
      : actualProvider !== "openai" && env.openaiApiKey
        ? "openai"
        : null;
    if (!fallback) throw generationError;
    actualProvider = fallback;
    generation = await generateAnswer(
      fallback,
      state.query,
      state.sources,
      env,
      openai,
      generationConversation,
    );
  }

  return {
    actualProvider,
    model: providerModel(actualProvider, env),
    usage: generation.usage,
    answer: generation.answer,
    trace: [trace(
      "generate",
      "Write answer",
      `${providerModel(actualProvider, env)} used ${state.sources.length} grounded sources`,
      startedAt,
    )],
  };
}

function validateNode(state: State): Partial<State> {
  const startedAt = performance.now();
  if (!state.answer) return { trace: [trace("validate", "Check citations", "No answer to validate", startedAt)] };

  const validCitations = state.answer.citations.filter((citation) => state.sources.some((source) => {
    if (citation.watch_url && source.watch_url === citation.watch_url) return true;
    return citation.title === source.title
      && citation.start_seconds >= source.start_seconds - 1
      && citation.start_seconds <= source.end_seconds + 1;
  }));
  const removed = state.answer.citations.length - validCitations.length;
  const missing = validCitations.length === 0 && state.sources.length > 0;
  const caveats = [...state.answer.caveats];
  if (removed > 0) caveats.push(`${removed} citation${removed === 1 ? " was" : "s were"} removed because the source could not be verified.`);
  if (missing) caveats.push("No model citation passed source validation; review the retrieved transcript moments directly.");

  return {
    answer: {
      ...state.answer,
      citations: validCitations,
      caveats: caveats.slice(0, 4),
    },
    trace: [trace(
      "validate",
      "Check citations",
      `${validCitations.length} verified · ${removed} removed`,
      startedAt,
    )],
  };
}

function buildFollowUpGraph() {
  return new StateGraph(FollowUpState)
    .addNode("contextualize", contextualizeNode)
    .addNode("retrieve", retrieveNode)
    .addNode("rerank", rerankNode)
    .addNode("enrich", enrichNode)
    .addNode("generate", generateNode)
    .addNode("validate", validateNode)
    .addEdge(START, "contextualize")
    .addEdge("contextualize", "retrieve")
    .addConditionalEdges("retrieve", (state: State) => state.candidates.length === 0 ? "empty" : "continue", {
      empty: END,
      continue: "rerank",
    })
    .addEdge("rerank", "enrich")
    .addEdge("enrich", "generate")
    .addEdge("generate", "validate")
    .addEdge("validate", END)
    .compile();
}

let compiled: ReturnType<typeof buildFollowUpGraph> | null = null;

function getFollowUpGraph() {
  if (!compiled) compiled = buildFollowUpGraph();
  return compiled;
}

export type ExperimentalFollowUpResult = {
  relationship: Relationship;
  retrieval: RetrievalMode;
  reranked: boolean;
  sources: RagSource[];
  contextIds: string[];
  provider: AnswerProvider | null;
  model: string;
  usage: RagTokenUsage | null;
  answer: RagAnswer | null;
  trace: RagGraphTraceEntry[];
};

export async function runExperimentalFollowUp(input: {
  query: string;
  provider: AnswerProvider;
  conversation: RagConversationTurn[];
  contextIds: string[];
}): Promise<ExperimentalFollowUpResult> {
  const final = await getFollowUpGraph().invoke({
    query: input.query,
    requestedProvider: input.provider,
    conversation: input.conversation,
    contextIds: input.contextIds,
  });
  return {
    relationship: final.relationship,
    retrieval: final.retrieval,
    reranked: final.didRerank,
    sources: final.sources,
    contextIds: final.contextIdsOut,
    provider: final.actualProvider,
    model: final.model,
    usage: final.usage,
    answer: final.answer,
    trace: final.trace,
  };
}
