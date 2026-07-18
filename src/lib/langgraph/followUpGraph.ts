import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { generateAnswer, providerModel } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import type { AnswerProvider } from "@/lib/providers";
import { enrichCandidates, type RetrievalMode } from "@/lib/ragPipeline";
import { runRetrievalSubgraph } from "@/lib/langgraph/retrievalSubgraph";
import { getLangGraphCheckpointer } from "@/lib/langgraph/checkpointer";
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
  seedConversation: Annotation<RagConversationTurn[]>(replace<RagConversationTurn[]>(() => [])),
  seedContextIds: Annotation<string[]>(replace<string[]>(() => [])),
  testFailure: Annotation<"rerank_once" | null>({ reducer: (_p, n) => n, default: () => null }),
  testThreadId: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  conversation: Annotation<RagConversationTurn[]>(replace<RagConversationTurn[]>(() => [])),
  contextIds: Annotation<string[]>(replace<string[]>(() => [])),
  turnCount: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  retrievalQuery: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  relationship: Annotation<Relationship>({ reducer: (_p, n) => n, default: () => "same_topic" }),
  retrieval: Annotation<RetrievalMode>({ reducer: (_p, n) => n, default: () => "hybrid" }),
  reranked: Annotation<RagSearchResult[]>(replace<RagSearchResult[]>(() => [])),
  didRerank: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  sources: Annotation<RagSource[]>(replace<RagSource[]>(() => [])),
  contextIdsOut: Annotation<string[]>(replace<string[]>(() => [])),
  actualProvider: Annotation<AnswerProvider | null>({ reducer: (_p, n) => n, default: () => null }),
  model: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  usage: Annotation<RagTokenUsage | null>({ reducer: (_p, n) => n, default: () => null }),
  answer: Annotation<RagAnswer | null>({ reducer: (_p, n) => n, default: () => null }),
  trace: Annotation<RagGraphTraceEntry[]>({
    reducer: (previous, next) => next[0]?.node === "turn_start" ? next : previous.concat(next).slice(-80),
    default: () => [],
  }),
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

function initializeTurnNode(state: State): Partial<State> {
  const startedAt = performance.now();
  const firstTurn = state.conversation.length === 0;
  const conversation = firstTurn ? state.seedConversation : state.conversation;
  const contextIds = firstTurn ? state.seedContextIds : state.contextIds;
  return {
    conversation,
    contextIds,
    retrievalQuery: "",
    relationship: "same_topic",
    reranked: [],
    didRerank: false,
    sources: [],
    contextIdsOut: [],
    actualProvider: null,
    model: "",
    usage: null,
    answer: null,
    trace: [trace(
      "turn_start",
      "Restore thread",
      `${conversation.length} prior turns · ${contextIds.length} retained sources${firstTurn ? " · initialized from seed" : " · loaded from checkpoint"}`,
      startedAt,
    )],
  };
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

async function retrieveNode(state: State, config: Parameters<typeof runRetrievalSubgraph>[1]): Promise<Partial<State>> {
  const startedAt = performance.now();
  const keepPrior = state.relationship === "same_topic";
  const result = await runRetrievalSubgraph({
    query: state.retrievalQuery,
    keepPrior,
    contextIds: state.contextIds,
    testThreadId: state.testThreadId,
    testFailure: state.testFailure,
  }, config);
  return {
    retrieval: result.retrieval,
    reranked: result.reranked,
    didRerank: result.didRerank,
    trace: [...result.trace, trace(
      "retrieve",
      "Retrieval subgraph",
      `${result.retrieval} · ${result.reranked.length} ranked candidates · ${keepPrior ? "checkpoint context enabled" : "fresh topic"}`,
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

function commitTurnNode(state: State): Partial<State> {
  const startedAt = performance.now();
  if (!state.answer) {
    return { trace: [trace("commit", "Save checkpoint", "No answer to add to conversation", startedAt)] };
  }
  const conversation = [
    ...state.conversation,
    { question: state.query, answer: state.answer.answer },
  ];
  const retainedConversation = conversation.length <= 8
    ? conversation
    : [conversation[0], ...conversation.slice(-7)];
  return {
    conversation: retainedConversation,
    contextIds: state.contextIdsOut,
    turnCount: state.turnCount + 1,
    trace: [trace("commit", "Save checkpoint", `turn ${state.turnCount + 1} · ${retainedConversation.length} conversation turns persisted`, startedAt)],
  };
}

function buildFollowUpGraph(checkpointer: PostgresSaver) {
  return new StateGraph(FollowUpState)
    .addNode("initialize_turn", initializeTurnNode)
    .addNode("contextualize", contextualizeNode)
    .addNode("retrieve", retrieveNode)
    .addNode("enrich", enrichNode)
    .addNode("generate", generateNode)
    .addNode("validate", validateNode)
    .addNode("commit_turn", commitTurnNode)
    .addEdge(START, "initialize_turn")
    .addEdge("initialize_turn", "contextualize")
    .addEdge("contextualize", "retrieve")
    .addConditionalEdges("retrieve", (state: State) => state.reranked.length === 0 ? "empty" : "continue", {
      empty: END,
      continue: "enrich",
    })
    .addEdge("enrich", "generate")
    .addEdge("generate", "validate")
    .addEdge("validate", "commit_turn")
    .addEdge("commit_turn", END)
    .compile({ checkpointer });
}

let compiled: ReturnType<typeof buildFollowUpGraph> | null = null;

function getFollowUpGraph(): ReturnType<typeof buildFollowUpGraph> {
  if (!compiled) compiled = buildFollowUpGraph(getLangGraphCheckpointer());
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
  conversationTurns: number;
  turnIndex: number;
};

export type FollowUpCheckpointSummary = {
  checkpointId: string;
  parentCheckpointId: string | null;
  createdAt: string | null;
  node: string;
  nextNodes: string[];
  step: number | null;
  source: string;
  replayable: boolean;
  testConfig: {
    provider: AnswerProvider | null;
    failure: "rerank_once" | null;
    relationship: Relationship;
    turnIndex: number;
  };
  stateSummary: {
    conversationTurns: number;
    retainedSources: number;
    answerReady: boolean;
  };
};

function resultFromState(final: State): ExperimentalFollowUpResult {
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
    conversationTurns: final.conversation.length,
    turnIndex: final.turnCount,
  };
}

export async function runExperimentalFollowUp(input: {
  threadId: string;
  query: string;
  provider: AnswerProvider;
  seedConversation?: RagConversationTurn[];
  seedContextIds?: string[];
  testFailure?: "rerank_once" | null;
}): Promise<ExperimentalFollowUpResult> {
  const final = await getFollowUpGraph().invoke({
    query: input.query,
    requestedProvider: input.provider,
    seedConversation: input.seedConversation ?? [],
    seedContextIds: input.seedContextIds ?? [],
    testFailure: input.testFailure ?? null,
    testThreadId: input.threadId,
  }, { configurable: { thread_id: input.threadId } });
  return resultFromState(final);
}

export async function resumeExperimentalFollowUp(threadId: string): Promise<ExperimentalFollowUpResult> {
  const final = await getFollowUpGraph().invoke(null as never, {
    configurable: { thread_id: threadId },
  });
  return resultFromState(final);
}

function checkpointId(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const configurable = (config as { configurable?: unknown }).configurable;
  if (!configurable || typeof configurable !== "object") return null;
  const value = (configurable as { checkpoint_id?: unknown }).checkpoint_id;
  return typeof value === "string" ? value : null;
}

export async function listExperimentalFollowUpCheckpoints(
  threadId: string,
  limit = 50,
): Promise<FollowUpCheckpointSummary[]> {
  const history: FollowUpCheckpointSummary[] = [];
  for await (const snapshot of getFollowUpGraph().getStateHistory(
    { configurable: { thread_id: threadId, checkpoint_ns: "" } },
    { limit: Math.min(Math.max(limit, 1), 100) },
  )) {
    const id = checkpointId(snapshot.config);
    if (!id) continue;
    const values = snapshot.values as Partial<State>;
    const metadata = snapshot.metadata as Record<string, unknown>;
    const writes = metadata.writes && typeof metadata.writes === "object"
      ? Object.keys(metadata.writes as Record<string, unknown>)
      : [];
    const nextNodes = [...snapshot.next].map(String);
    const node = writes.length > 0
      ? writes.join(" + ")
      : nextNodes.length > 0
        ? `before ${nextNodes.join(" + ")}`
        : "complete";
    const hasTaskError = snapshot.tasks.some((task) => Boolean(task.error));
    history.push({
      checkpointId: id,
      parentCheckpointId: checkpointId(snapshot.parentConfig),
      createdAt: snapshot.createdAt ?? null,
      node,
      nextNodes,
      step: typeof metadata.step === "number" ? metadata.step : null,
      source: typeof metadata.source === "string" ? metadata.source : "unknown",
      replayable: nextNodes.length > 0 && !hasTaskError,
      testConfig: {
        provider: values.requestedProvider ?? null,
        failure: values.testFailure === "rerank_once" ? "rerank_once" : null,
        relationship: values.relationship === "new_topic" ? "new_topic" : "same_topic",
        turnIndex: typeof values.turnCount === "number" ? values.turnCount : 0,
      },
      stateSummary: {
        conversationTurns: Array.isArray(values.conversation) ? values.conversation.length : 0,
        retainedSources: Array.isArray(values.contextIds) ? values.contextIds.length : 0,
        answerReady: Boolean(values.answer),
      },
    });
  }
  return history;
}

export async function replayExperimentalFollowUp(input: {
  sourceThreadId: string;
  checkpointId: string;
  branchThreadId: string;
  testFailure?: "rerank_once" | null;
}): Promise<{
  result: ExperimentalFollowUpResult;
  forkCheckpointId: string;
}> {
  const graph = getFollowUpGraph();
  const sourceConfig = {
    configurable: {
      thread_id: input.sourceThreadId,
      checkpoint_ns: "",
      checkpoint_id: input.checkpointId,
    },
  };
  const snapshot = await graph.getState(sourceConfig);
  if (checkpointId(snapshot.config) !== input.checkpointId) throw new Error("Checkpoint not found on the authorized thread.");
  if (snapshot.next.length === 0) throw new Error("The selected checkpoint is terminal and has no nodes to replay.");
  if (snapshot.tasks.some((task) => Boolean(task.error))) throw new Error("Checkpoints with failed pending tasks cannot be branched by this test control.");

  const checkpointer = getLangGraphCheckpointer();
  const tuple = await checkpointer.getTuple(sourceConfig);
  if (!tuple || tuple.config.configurable?.checkpoint_ns !== "") {
    throw new Error("Checkpoint not found on the authorized root graph.");
  }
  if (!tuple.metadata) throw new Error("The selected checkpoint has no replay metadata.");

  const replayMetadata = {
    ...tuple.metadata,
    replay_origin_thread_id: input.sourceThreadId,
    replay_origin_checkpoint_id: input.checkpointId,
  } as typeof tuple.metadata;
  const clonedConfig = await checkpointer.put(
    { configurable: { thread_id: input.branchThreadId, checkpoint_ns: "" } },
    tuple.checkpoint,
    replayMetadata,
    tuple.checkpoint.channel_versions,
  );
  const forkConfig = await graph.updateState(clonedConfig, {
    testFailure: input.testFailure ?? null,
    testThreadId: input.branchThreadId,
  });
  const final = await graph.invoke(null as never, forkConfig);
  return {
    result: resultFromState(final),
    forkCheckpointId: checkpointId(forkConfig) ?? "",
  };
}
