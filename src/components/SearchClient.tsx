"use client";

import {
  BarChart3,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Dumbbell,
  ExternalLink,
  FlaskConical,
  GitBranch,
  GitCompareArrows,
  Lightbulb,
  ListOrdered,
  Loader2,
  MessageSquare,
  Play,
  Search,
  Send,
  Sparkles,
  Timer,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type {
  RagAnalysis,
  RagAnalyzeResponse,
  RagAnswer,
  RagAnswerCitation,
  RagAskResponse,
  RagExperimentalFollowUpResponse,
  RagGraphAskResponse,
  RagGraphTraceEntry,
  RagSearchResponse,
  RagSearchResult,
  RagTokenUsage,
} from "@/lib/types";
import {
  PROVIDER_META,
  normalizeProvider,
  type AnswerProvider,
  type ProviderInfo,
} from "@/lib/providers";
import { timestampUrl } from "@/lib/ragUtils";
import { LangTests } from "@/components/LangTests";
import { InstructorCompare } from "@/components/InstructorCompare";

function secondsLabel(value: number | string | null | undefined) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric ?? NaN)) return "0:00";
  const total = Math.max(0, Math.floor(numeric as number));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function timestampRangeLabel(
  start: number | string | null | undefined,
  end: number | string | null | undefined,
) {
  const startSeconds = Number(start);
  const endSeconds = Number(end);
  return Number.isFinite(endSeconds) && endSeconds > startSeconds
    ? `${secondsLabel(start)}–${secondsLabel(end)}`
    : secondsLabel(start);
}

function titleFor(result: RagSearchResult) {
  return result.metadata?.video_title || result.video_id;
}

function scoreFor(result: RagSearchResult) {
  const raw = result.similarity ?? result.rank ?? 0;
  return raw.toFixed(2);
}

type Tab = "search" | "app" | "compare" | "map" | "tests";
type Mode = "keyword" | "semantic";
type FollowUpEngine = "classic" | "langgraph";
type FollowUpResponse = RagAskResponse & {
  engine: FollowUpEngine;
  relationship?: "same_topic" | "new_topic";
  trace?: RagGraphTraceEntry[];
  total_ms?: number;
};
type FollowUpTurn = { question: string; response: FollowUpResponse };

function createThreadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

// One engine's result inside the side-by-side comparison. `trace`/`serverMs` are
// only populated for the LangGraph engine, which reports its executed nodes.
type EngineResult = {
  engine: "classic" | "langgraph";
  label: string;
  sublabel: string;
  answer: RagAnswer;
  model: string;
  retrieval: string;
  reranked: boolean;
  sourceCount: number;
  clientMs: number;
  serverMs?: number;
  trace?: RagGraphTraceEntry[];
};

type Comparison = { classic: EngineResult; graph: EngineResult } | null;

const ANSWER_PROVIDER_STORAGE_KEY = "zencub-rag:answer-provider";

async function postTimed<T>(url: string, body: unknown) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as T & { error?: string };
  return { ok: res.ok, ms: Math.round(performance.now() - started), payload };
}

/* ---- System Map static content (accurate to the real corpus) ---- */
const PIPELINE = [
  { step: "01", icon: Database, label: "Source", title: "Postgres Tables", desc: "Reads read-only rag_ tables (videos, transcripts, techniques, chunks) synced from source.", tag: "Supabase", tone: "done" as const },
  { step: "02", icon: Cpu, label: "Embed", title: "OpenAI Embeddings", desc: "text-embedding-3-small encodes every chunk into a 1536-dim vector at ingest.", tag: "embed-3-small", tone: "done" as const },
  { step: "03", icon: Search, label: "Retrieve", title: "Hybrid Search", desc: "pgvector cosine + Postgres full-text, fused with Reciprocal Rank Fusion.", tag: "pgvector + RRF", tone: "live" as const },
  { step: "04", icon: Zap, label: "Rerank", title: "Diversity + Rerank", desc: "Per-video diversity cap, then an LLM reranks candidates by intent.", tag: "rerank", tone: "live" as const },
  { step: "05", icon: MessageSquare, label: "Generate", title: "Cited Answer", desc: "Answers are grounded strictly in retrieved chunks, each claim citation-linked.", tag: "gpt-4o-mini", tone: "live" as const },
];

const METRICS = [
  { value: "12,104", label: "chunks" },
  { value: "2,298", label: "transcripts" },
  { value: "2,844", label: "techniques" },
  { value: "12,104", label: "embedded" },
];

const EXPLAIN_STEPS = [
  "Query is embedded and full-text-searched over the corpus in parallel",
  "Vector + text hits are fused with Reciprocal Rank Fusion (no score threshold)",
  "Results are capped per video for source diversity",
  "An LLM reranks the pool by intent, then technique metadata is attached",
  "The answer model receives only retrieved chunks and returns citations",
];

const USE_CASES = [
  { icon: Search, title: "Technique lookup", desc: "Instant recall of any taught technique across every video." },
  { icon: Users, title: "Instructor comparison", desc: "Compare how different instructors explain the same position." },
  { icon: BarChart3, title: "Study stacks", desc: "Turn search results into focused study lists for a problem." },
  { icon: Dumbbell, title: "Debug your game", desc: "Search the problem you're having and inspect the clips that cover it." },
];

const PITCH_LINES = [
  "Citation-grounded answers, no hallucinated sources",
  "Hybrid keyword + semantic retrieval with RRF",
  "Full 12,104-chunk corpus searchable in one query",
];

const EVAL_STRIP = [
  { value: "19/19", label: "eval queries passing" },
  { value: "4", label: "checks per query" },
  { value: "12,104", label: "chunks embedded" },
  { value: "RRF", label: "hybrid fusion" },
];

const TABLE_ROWS: Array<{ table: string; count: string; type: "Core" | "Meta" | "Vectors" | "Logs"; desc: string }> = [
  { table: "rag_videos", count: "2,402", type: "Core", desc: "Video title, source URL, platform, channel, thumbnail, slug." },
  { table: "rag_video_transcripts", count: "2,298", type: "Core", desc: "Raw transcript JSON segments and transcript metadata." },
  { table: "rag_techniques", count: "2,844", type: "Meta", desc: "Technique names, positions, summaries, steps, timestamps." },
  { table: "rag_creators", count: "468", type: "Meta", desc: "Canonical creator names, aliases, opt-out field." },
  { table: "rag_transcript_chunks", count: "12,104", type: "Vectors", desc: "Searchable timestamped chunks + embedding vectors." },
  { table: "rag_search_logs", count: "Live", type: "Logs", desc: "Every keyword, semantic, analysis, Ask AI, and follow-up query." },
  { table: "rag_followup_experiment_runs", count: "Ready", type: "Logs", desc: "Server-only LangGraph follow-up timing, routing, model, and outcome telemetry." },
];

const MODEL_USAGE_ROWS = [
  { action: "Regular Search", usesLlm: "No", local: "No", openrouter: "No", openai: "No" },
  { action: "Semantic Search", usesLlm: "No · embedding only", local: "No", openrouter: "No", openai: "Query embedding" },
  { action: "Analyze Results", usesLlm: "Yes", local: "No", openrouter: "No", openai: "Analysis generation" },
  { action: "Ask AI · local Qwen selected", usesLlm: "Yes", local: "Final answer", openrouter: "No", openai: "Embedding + usually reranking" },
  { action: "Ask AI · Qwen3 235B selected", usesLlm: "Yes", local: "No", openrouter: "Final answer", openai: "Embedding + usually reranking" },
  { action: "Ask AI · Claude selected", usesLlm: "Yes", local: "Final answer", openrouter: "No", openai: "Embedding + usually reranking" },
  { action: "Ask AI · OpenAI selected", usesLlm: "Yes", local: "No", openrouter: "No", openai: "Embedding + reranking + final answer" },
  { action: "Ask follow-up", usesLlm: "Yes", local: "Final answer when selected", openrouter: "Final answer when selected", openai: "Context retrieval + reranking; final answer when selected" },
  { action: "Page load", usesLlm: "No", local: "Availability probes only", openrouter: "Key check only", openai: "No model call" },
];

/* ---- Engine architecture (Classic vs LangGraph) ---- */
const ENGINES: Array<{ key: "classic" | "langgraph"; name: string; sub: string; icon: typeof Search; how: string; points: string[] }> = [
  {
    key: "classic",
    name: "Classic",
    sub: "OpenAI SDK · hand-wired",
    icon: Cpu,
    how: "Imperative. One route handler calls each stage in order with plain async/await.",
    points: [
      "Linear control flow, top to bottom",
      "Manual Promise.all for parallel retrieval",
      "try/catch fallback around each stage",
      "Values threaded by hand between steps",
      "No built-in tracing or timing",
    ],
  },
  {
    key: "langgraph",
    name: "LangGraph",
    sub: "StateGraph · LangChain",
    icon: Workflow,
    how: "Declarative. Stages are nodes; a compiled StateGraph routes typed state between them.",
    points: [
      "Typed shared state via Annotation channels",
      "Each node is (state) → partial state update",
      "Edges declare flow; conditionals branch it",
      "Calls run through ChatOpenAI / OpenAIEmbeddings",
      "Per-node trace + timing captured for free",
    ],
  },
];

// The five nodes of the LangGraph, in execution order. Same math the classic
// engine runs — here each stage is a graph node instead of a function call.
const GRAPH_NODES: Array<{ id: string; icon: typeof Search; tech: string; desc: string }> = [
  { id: "retrieve", icon: Search, tech: "OpenAIEmbeddings + Supabase", desc: "Embed the query, run vector + full-text search in parallel." },
  { id: "fuse", icon: Zap, tech: "pure fn · RRF", desc: "Reciprocal Rank Fusion, then cap results per video for diversity." },
  { id: "rerank", icon: ListOrdered, tech: "ChatOpenAI", desc: "An LLM reorders the candidate pool by true intent." },
  { id: "enrich", icon: Database, tech: "Supabase + pure fn", desc: "Refine timestamps and attach technique metadata." },
  { id: "generate", icon: MessageSquare, tech: "ChatOpenAI", desc: "Write a cited answer grounded only in the retrieved sources." },
];

const LG_CONCEPTS: Array<{ icon: typeof Search; term: string; def: string }> = [
  { icon: Database, term: "State", def: "A typed object (Annotation.Root) with one channel per field. Reducers decide how updates merge — the trace channel appends, the rest overwrite." },
  { icon: Cpu, term: "Nodes", def: "Async functions shaped (state) → partial state. Each does one job and returns only the fields it changed." },
  { icon: GitBranch, term: "Edges", def: "Static edges fix the order. One conditional edge after fuse routes to END when nothing was retrieved, otherwise on to rerank." },
];

export function SearchClient() {
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("knee cut");
  const [mode, setMode] = useState<Mode>("keyword");
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [askLoading, setAskLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  const [comparison, setComparison] = useState<Comparison>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RagAnalysis | null>(null);
  const [analysisModel, setAnalysisModel] = useState("");
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [answerModel, setAnswerModel] = useState("");
  const [answerUsage, setAnswerUsage] = useState<RagTokenUsage | null>(null);
  const [answerProvider, setAnswerProvider] = useState<AnswerProvider | "">("");
  const [answerRetrieval, setAnswerRetrieval] = useState<"vector" | "text" | "metadata" | "hybrid" | "">("");
  const [answerQuery, setAnswerQuery] = useState("");
  const [answerContextIds, setAnswerContextIds] = useState<string[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpTurn[]>([]);
  const [followUpQuestion, setFollowUpQuestion] = useState("");
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpEngine, setFollowUpEngine] = useState<FollowUpEngine>("classic");
  const [followUpThreadId, setFollowUpThreadId] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<AnswerProvider | "">("");

  // Discover which answer engines exist on the host so we only offer available
  // ones and preselect the server's default (local Qwen on the Mac Studio).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/rag/providers")
      .then((res) => res.json())
      .then((data: { providers?: ProviderInfo[]; default?: AnswerProvider }) => {
        if (cancelled) return;
        const detected = data.providers ?? [];
        let remembered: AnswerProvider | undefined;
        try {
          remembered = normalizeProvider(localStorage.getItem(ANSWER_PROVIDER_STORAGE_KEY));
        } catch {
          // Storage can be disabled in private or locked-down browser contexts.
        }
        const selected = remembered && detected.some((item) => item.id === remembered && item.available)
          ? remembered
          : data.default ?? "";
        setProviders(detected);
        setProvider(selected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function selectProvider(next: AnswerProvider) {
    setProvider(next);
    try {
      localStorage.setItem(ANSWER_PROVIDER_STORAGE_KEY, next);
    } catch {
      // The in-memory choice still works when persistent storage is unavailable.
    }
  }

  async function runSearch(trimmed: string) {
    setLoading(true);
    setMode("keyword");
    setError(null);
    setActionError(null);
    setAnalysis(null);
    setAnswer(null);
    setComparison(null);
    setFollowUps([]);
    setFollowUpError(null);
    try {
      const res = await fetch(`/api/rag/search?q=${encodeURIComponent(trimmed)}&limit=12`);
      const payload = (await res.json()) as RagSearchResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Search failed");
      setResults(payload.results);
      setSearchedQuery(payload.query);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setSearchedQuery(trimmed);
    } finally {
      setLoading(false);
    }
  }

  async function runVectorSearch() {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setLoading(true);
    setMode("semantic");
    setError(null);
    setActionError(null);
    setAnalysis(null);
    setAnswer(null);
    setComparison(null);
    setFollowUps([]);
    setFollowUpError(null);
    try {
      const res = await fetch(`/api/rag/vector-search?q=${encodeURIComponent(trimmed)}&limit=12`);
      const payload = (await res.json()) as RagSearchResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Semantic search failed");
      setResults(payload.results);
      setSearchedQuery(payload.query);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Semantic search failed");
      setResults([]);
      setSearchedQuery(trimmed);
    } finally {
      setLoading(false);
    }
  }

  async function analyzeResults() {
    const trimmed = searchedQuery || query.trim();
    if (trimmed.length < 2) return;
    setAnalysisLoading(true);
    setActionError(null);
    try {
      const res = await fetch("/api/rag/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const payload = (await res.json()) as RagAnalyzeResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Analysis failed");
      setAnalysis(payload.analysis);
      setAnalysisModel(payload.model);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Analysis failed");
      setAnalysis(null);
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function askQuestion(questionOverride?: string, providerOverride?: AnswerProvider) {
    const trimmed = questionOverride?.trim() || searchedQuery || query.trim();
    if (trimmed.length < 2) return;
    setAskLoading(true);
    setActionError(null);
    try {
      const res = await fetch("/api/rag/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, retrieval: "auto", provider: providerOverride || provider || undefined }),
      });
      const payload = (await res.json()) as RagAskResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Ask failed");
      setAnswer(payload.answer);
      setAnswerModel(payload.model);
      setAnswerUsage(payload.usage);
      setAnswerProvider(payload.provider);
      setAnswerRetrieval(payload.retrieval);
      setAnswerQuery(payload.query);
      setAnswerContextIds(payload.context_ids);
      setFollowUps([]);
      setFollowUpQuestion("");
      setFollowUpError(null);
      setFollowUpThreadId(createThreadId());
      setProvider(payload.provider);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Ask failed");
      setAnswer(null);
    } finally {
      setAskLoading(false);
    }
  }

  // Runs the classic OpenAI-SDK pipeline and the LangGraph pipeline on the same
  // query in parallel, then renders both answers side-by-side for comparison.
  async function compareEngines() {
    const trimmed = searchedQuery || query.trim();
    if (trimmed.length < 2) return;
    setCompareLoading(true);
    setActionError(null);
    setAnswer(null);
    setAnalysis(null);
    setComparison(null);
    try {
      const [classic, graph] = await Promise.all([
        postTimed<RagAskResponse>("/api/rag/ask", { query: trimmed, retrieval: "auto", provider: "openai" }),
        postTimed<RagGraphAskResponse>("/api/rag/graph-ask", { query: trimmed, retrieval: "auto" }),
      ]);
      if (!classic.ok) throw new Error(classic.payload.error ?? "Classic engine failed");
      if (!graph.ok) throw new Error(graph.payload.error ?? "LangGraph engine failed");

      setComparison({
        classic: {
          engine: "classic",
          label: "Classic",
          sublabel: "OpenAI SDK · hand-rolled",
          answer: classic.payload.answer,
          model: classic.payload.model,
          retrieval: classic.payload.retrieval,
          reranked: Boolean(classic.payload.reranked),
          sourceCount: classic.payload.source_count,
          clientMs: classic.ms,
        },
        graph: {
          engine: "langgraph",
          label: "LangGraph",
          sublabel: "StateGraph · LangChain",
          answer: graph.payload.answer,
          model: graph.payload.model,
          retrieval: graph.payload.retrieval,
          reranked: graph.payload.reranked,
          sourceCount: graph.payload.source_count,
          clientMs: graph.ms,
          serverMs: graph.payload.total_ms,
          trace: graph.payload.trace,
        },
      });
      setSearchedQuery(trimmed);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Comparison failed");
      setComparison(null);
    } finally {
      setCompareLoading(false);
    }
  }

  async function askFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = followUpQuestion.trim();
    if (trimmed.length < 2 || !answer || !answerProvider) return;

    const latestResponse = followUps.at(-1)?.response;
    const conversation = [
      { question: answerQuery, answer: answer.answer },
      ...followUps.map((turn) => ({ question: turn.question, answer: turn.response.answer.answer })),
    ];

    setFollowUpLoading(true);
    setFollowUpError(null);
    try {
      const selectedProvider = provider || latestResponse?.provider || answerProvider;
      const endpoint = followUpEngine === "langgraph" ? "/api/rag/graph-follow-up" : "/api/rag/ask";
      const hasPersistedGraphTurn = followUps.some((turn) => turn.response.engine === "langgraph");
      // If classic turns were added after a persisted graph turn, start a new
      // graph thread and seed the complete visible conversation once. This
      // avoids silently omitting classic turns from an older checkpoint.
      const restartGraphTrack = followUpEngine === "langgraph"
        && hasPersistedGraphTurn
        && latestResponse?.engine === "classic";
      const threadId = restartGraphTrack ? createThreadId() : followUpThreadId || createThreadId();
      const shouldSeedGraph = !hasPersistedGraphTurn || restartGraphTrack;
      const requestBody = followUpEngine === "langgraph"
        ? {
            query: trimmed,
            provider: selectedProvider,
            thread_id: threadId,
            ...(shouldSeedGraph ? {
              seed: {
                conversation,
                context_ids: latestResponse?.context_ids ?? answerContextIds,
              },
            } : {}),
          }
        : {
            query: trimmed,
            retrieval: "auto",
            provider: selectedProvider,
            conversation,
            context_ids: latestResponse?.context_ids ?? answerContextIds,
          };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = (await res.json()) as (RagAskResponse | RagExperimentalFollowUpResponse) & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Follow-up failed");
      const response: FollowUpResponse = followUpEngine === "langgraph"
        ? payload as RagExperimentalFollowUpResponse
        : { ...(payload as RagAskResponse), engine: "classic" };
      setFollowUps((current) => [...current, { question: trimmed, response }]);
      setFollowUpThreadId("thread_id" in payload ? payload.thread_id : threadId);
      setFollowUpQuestion("");
    } catch (err) {
      setFollowUpError(err instanceof Error ? err.message : "Follow-up failed");
    } finally {
      setFollowUpLoading(false);
    }
  }

  const latestConversationAnswer = followUps.at(-1)?.response.answer ?? answer;
  const followUpPlaceholder = latestConversationAnswer?.suggested_follow_up
    ?? "Ask a follow-up about this answer…";
  const inAppProviders = providers.filter((item) => item.id === "openrouter" || item.id === "openai");
  const inAppProvider: AnswerProvider | "" = inAppProviders.some((item) => item.id === provider && item.available)
    ? provider
    : inAppProviders.find((item) => item.id === "openrouter" && item.available)?.id
      ?? inAppProviders.find((item) => item.id === "openai" && item.available)?.id
      ?? "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    void runSearch(trimmed);
  }

  function submitAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    if (!inAppProvider) {
      setActionError("Qwen3 235B or OpenAI must be available to use the In App Experience.");
      return;
    }
    void askQuestion(trimmed, inAppProvider);
  }

  function useExample(next: string) {
    setQuery(next);
    setTab("search");
    void runSearch(next);
  }

  function useAnswerSuggestion(next: string) {
    setQuery(next);
    if (tab === "app") {
      if (inAppProvider) void askQuestion(next, inAppProvider);
      return;
    }
    useExample(next);
  }

  function showInAppExperience() {
    setTab("app");
    setActionError(null);
    if (answerProvider && answerProvider !== "openrouter" && answerProvider !== "openai") {
      setAnswer(null);
      setFollowUps([]);
      setFollowUpError(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <header className="flex items-start justify-between gap-4 mb-6">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">ZenCub RAG</p>
            <h1 className="text-3xl sm:text-[34px] font-bold tracking-tight mt-1">Transcript Search</h1>
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold bg-card border border-border rounded-full px-3 py-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            Read-only corpus
          </div>
        </header>

        {/* Tabs */}
        <div className="flex max-w-full gap-1 overflow-x-auto p-1 rounded-xl bg-secondary border border-border w-fit mb-5">
          <TabButton active={tab === "search"} onClick={() => setTab("search")} icon={Search} label="Search" />
          <TabButton active={tab === "app"} onClick={showInAppExperience} icon={MessageSquare} label="In App Experience" />
          <TabButton active={tab === "compare"} onClick={() => setTab("compare")} icon={Users} label="Instructor Compare" />
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={Workflow} label="System Map" />
          <TabButton active={tab === "tests"} onClick={() => setTab("tests")} icon={FlaskConical} label="Lang Tests" />
        </div>

        {tab !== "map" && tab !== "tests" && tab !== "compare" ? (
          <div className="space-y-4">
            {/* Search bar */}
            <form onSubmit={tab === "app" ? submitAsk : submit} className="flex items-center gap-3 px-4 sm:px-5 py-3 rounded-2xl bg-card border border-border shadow-sm">
              {tab === "app"
                ? <Sparkles className="shrink-0 text-accent" size={19} />
                : <Search className="shrink-0 text-muted-foreground" size={19} />}
              <input
                className="flex-1 min-w-0 bg-transparent text-foreground placeholder:text-muted-foreground text-[15px] outline-none"
                placeholder={tab === "app"
                  ? "Ask about a technique, position, or problem..."
                  : "Search knee cut, saddle entries, crossface details..."}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={tab === "app" ? "Ask ZenCub AI" : "Search transcript chunks"}
              />
              <div className="group relative shrink-0">
                <button
                  type="submit"
                  disabled={tab === "app" ? askLoading || !inAppProvider : loading}
                  aria-describedby={tab === "app" ? "in-app-ask-tooltip" : undefined}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
                >
                  {tab === "app" && askLoading
                    ? <Loader2 size={15} className="animate-spin" />
                    : tab === "app"
                      ? <Sparkles size={15} />
                      : loading && mode === "keyword"
                        ? <Loader2 size={15} className="animate-spin" />
                        : <Search size={15} />}
                  <span>{tab === "app" ? (askLoading ? "Thinking…" : "Ask AI") : "Search"}</span>
                </button>
                {tab === "app" && (
                  <span
                    id="in-app-ask-tooltip"
                    role="tooltip"
                    className="pointer-events-none absolute right-0 top-full z-20 mt-2 w-64 rounded-lg bg-foreground px-3 py-2 text-center text-xs font-medium leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    Use hybrid retrieval to answer from transcript evidence, with timestamped video references.
                  </span>
                )}
              </div>
            </form>

            {/* Action buttons */}
            {tab === "search" && <div className="flex flex-wrap gap-2">
              <ActionButton
                onClick={runVectorSearch}
                loading={loading && mode === "semantic"}
                icon={Sparkles}
                label="Semantic Search"
                tooltip="Search transcript chunks by meaning, even when they use different words than your query."
              />
              <ActionButton
                onClick={analyzeResults}
                loading={analysisLoading}
                icon={Brain}
                label="Analyze Results"
                tooltip="Find the top keyword matches, then summarize the best watch moments, key details, and study order."
              />
              <ActionButton
                onClick={() => { void askQuestion(); }}
                loading={askLoading}
                icon={MessageSquare}
                label="Ask AI"
                tooltip="Use hybrid retrieval to generate an answer grounded in transcript sources, with citations."
              />
              <ActionButton
                onClick={compareEngines}
                loading={compareLoading}
                icon={GitCompareArrows}
                label="Compare Engines"
                tooltip="Run the same question through the classic OpenAI-SDK pipeline and a LangGraph/LangChain pipeline, side-by-side, with timing and the LangGraph node trace."
              />
            </div>}

            {/* LangGraph reference */}
            {tab === "search" && <div className="flex items-start gap-2.5 rounded-xl border border-border bg-secondary/50 px-3.5 py-2.5">
              <Workflow size={14} className="text-accent shrink-0 mt-0.5" />
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                <span className="font-bold text-foreground">Compare Engines</span> answers your query two ways — the classic
                OpenAI-SDK pipeline and a{" "}
                <span className="font-bold text-foreground">LangGraph</span> StateGraph — side-by-side with per-node timing.{" "}
                <button
                  type="button"
                  onClick={() => setTab("map")}
                  className="font-bold text-accent hover:underline"
                >
                  See how it works in the System Map →
                </button>
              </p>
            </div>}

            {/* Answer engine selector — only the providers this host can reach */}
            {providers.length > 0 && (
              <ProviderSelector
                providers={tab === "app" ? inAppProviders : providers}
                selected={tab === "app" ? inAppProvider : provider}
                onSelect={selectProvider}
              />
            )}

            {/* Summary row */}
            {tab === "search" && searchedQuery && (
              <div className="flex justify-between items-center text-xs text-muted-foreground px-1">
                <span>
                  {results.length} result{results.length === 1 ? "" : "s"} for{" "}
                  <span className="text-foreground font-semibold">&quot;{searchedQuery}&quot;</span>
                </span>
                <span>{mode === "semantic" ? "Semantic · cosine similarity" : "Keyword · full-text"}</span>
              </div>
            )}

            {tab === "search" && error && <Banner tone="error">{error}</Banner>}
            {actionError && <Banner tone="error">{actionError}</Banner>}

            {/* Engine Comparison */}
            {tab === "search" && comparison && <EngineComparison comparison={comparison} />}

            {/* AI Answer */}
            {answer && (
              <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-accent/12 flex items-center justify-center">
                      <Sparkles size={14} className="text-accent" />
                    </div>
                    <h2 className="text-base font-bold">AI Answer</h2>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {answerProvider && (
                      <span className="flex items-center gap-1 text-[11px] font-bold text-accent bg-accent/12 rounded-full px-2.5 py-1">
                        <Cpu size={11} />
                        {PROVIDER_META[answerProvider].label}
                      </span>
                    )}
                    <span className="text-[11px] font-bold text-muted-foreground bg-secondary rounded-full px-2.5 py-1">
                      {answerModel}
                      {answerRetrieval ? ` · ${answerRetrieval}` : ""}
                    </span>
                  </div>
                </div>
                <p className="text-[15px] leading-relaxed text-foreground/85 whitespace-pre-line">{answer.answer}</p>

                {answer.key_takeaways.length > 0 && (
                  <ul className="space-y-1.5">
                    {answer.key_takeaways.map((t, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-foreground/75">
                        <span className="text-accent mt-1">·</span>
                        {t}
                      </li>
                    ))}
                  </ul>
                )}

                <VideoReferences citations={answer.citations} />

                {answer.follow_up_searches.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {answer.follow_up_searches.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => useAnswerSuggestion(s)}
                        className="text-xs font-semibold text-foreground bg-secondary border border-border rounded-full px-3 py-1.5 hover:border-foreground/30 transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}

                {answer.caveats.length > 0 && (
                  <p className="text-xs text-muted-foreground pt-1 border-t border-border">
                    {answer.caveats.join(" · ")}
                  </p>
                )}

                {answerProvider && (
                  <AnswerUsage provider={answerProvider} model={answerModel} usage={answerUsage} />
                )}

                <div className="pt-4 mt-4 border-t border-border space-y-4">
                  <div>
                    <h3 className="text-sm font-bold">Ask a follow-up</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Your next question will use the selected answer engine, this conversation, and its transcript context.
                    </p>
                  </div>

                  {followUps.length > 0 && (
                    <div className="space-y-3" aria-live="polite">
                      {followUps.map((turn, index) => (
                        <div key={`${turn.question}-${index}`} className="space-y-2">
                          <div className="ml-auto max-w-[90%] rounded-xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
                            {turn.question}
                          </div>
                          <div className="rounded-xl rounded-tl-sm border border-border bg-secondary p-3.5 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-muted-foreground">
                                {turn.response.engine === "langgraph" ? <Workflow size={10} /> : <Cpu size={10} />}
                                {turn.response.engine === "langgraph" ? "LangGraph experiment" : "Classic follow-up"}
                              </span>
                              <span className="flex items-center gap-1 text-[10px] font-bold text-muted-foreground">
                                <Cpu size={10} />
                                {PROVIDER_META[turn.response.provider].label} · {turn.response.model}
                              </span>
                            </div>
                            <p className="text-sm leading-relaxed text-foreground/85 whitespace-pre-line">
                              {turn.response.answer.answer}
                            </p>
                            {turn.response.answer.key_takeaways.length > 0 && (
                              <ul className="space-y-1">
                                {turn.response.answer.key_takeaways.map((takeaway, takeawayIndex) => (
                                  <li key={takeawayIndex} className="flex items-start gap-2 text-xs text-foreground/70">
                                    <span className="text-accent mt-0.5">·</span>
                                    {takeaway}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <VideoReferences citations={turn.response.answer.citations} compact />
                            {turn.response.answer.caveats.length > 0 && (
                              <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                                {turn.response.answer.caveats.join(" · ")}
                              </p>
                            )}
                            <AnswerUsage
                              provider={turn.response.provider}
                              model={turn.response.model}
                              usage={turn.response.usage}
                            />
                            {turn.response.engine === "langgraph" && (
                              <details className="rounded-lg border border-border bg-card px-3 py-2">
                                <summary className="cursor-pointer text-[11px] font-bold text-foreground">
                                  Experimental flow · {turn.response.relationship === "new_topic" ? "new topic" : "continued topic"}
                                  {turn.response.total_ms ? ` · ${turn.response.total_ms}ms` : ""}
                                </summary>
                                {turn.response.trace && (
                                  <ol className="mt-2 space-y-1.5">
                                    {turn.response.trace.map((node) => (
                                      <li key={`${node.node}-${node.ms}`} className="flex items-start gap-2 text-[10px] text-muted-foreground">
                                        <span className="font-bold text-foreground">{node.label}</span>
                                        <span className="min-w-0 flex-1">{node.detail}</span>
                                        <span className="shrink-0 tabular-nums">{node.ms}ms</span>
                                      </li>
                                    ))}
                                  </ol>
                                )}
                              </details>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <form onSubmit={askFollowUp} className="space-y-3">
                    <div className="rounded-xl border border-border bg-secondary/60 p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-black uppercase tracking-wider text-muted-foreground">Follow-up path</span>
                        <div className="flex rounded-lg border border-border bg-card p-1" role="group" aria-label="Follow-up path">
                          <button
                            type="button"
                            onClick={() => setFollowUpEngine("classic")}
                            className={followUpEngine === "classic"
                              ? "rounded-md bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground"
                              : "rounded-md px-2.5 py-1 text-[11px] font-bold text-muted-foreground hover:text-foreground"}
                          >
                            Classic
                          </button>
                          <button
                            type="button"
                            onClick={() => setFollowUpEngine("langgraph")}
                            className={followUpEngine === "langgraph"
                              ? "flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground"
                              : "flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold text-muted-foreground hover:text-foreground"}
                          >
                            <Workflow size={10} />
                            LangGraph · Experimental
                          </button>
                        </div>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {followUpEngine === "classic"
                          ? "Classic keeps the proven follow-up path. It carries the conversation and previous transcript sources forward."
                          : "LangGraph restores this thread from Postgres, runs parallel retrieval in a private subgraph, verifies citations, and checkpoints the new turn."}
                      </p>
                    </div>
                    <textarea
                      value={followUpQuestion}
                      onChange={(event) => setFollowUpQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      rows={3}
                      maxLength={1_000}
                      disabled={followUpLoading}
                      aria-label="Ask a follow-up question"
                      placeholder={followUpPlaceholder}
                      className="w-full resize-y rounded-xl border border-border bg-secondary px-3.5 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/30 disabled:opacity-60"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter to send</span>
                      <button
                        type="submit"
                        disabled={followUpLoading || followUpQuestion.trim().length < 2}
                        className="inline-flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {followUpLoading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                        {followUpLoading ? "Thinking…" : "Ask follow-up"}
                      </button>
                    </div>
                    {followUpError && (
                      <p role="alert" className="text-xs font-semibold text-red-600">{followUpError}</p>
                    )}
                  </form>
                </div>
              </div>
            )}

            {/* Corpus Analysis */}
            {tab === "search" && analysis && (
              <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-secondary flex items-center justify-center">
                      <Brain size={14} className="text-foreground" />
                    </div>
                    <h2 className="text-base font-bold">Corpus Analysis</h2>
                  </div>
                  <span className="text-[11px] font-bold text-muted-foreground bg-secondary rounded-full px-2.5 py-1 shrink-0">
                    {analysisModel}
                  </span>
                </div>
                <p className="text-sm text-foreground/75 leading-relaxed">{analysis.summary}</p>

                {analysis.best_moments.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <ListOrdered size={12} />
                      Key Moments
                    </p>
                    {analysis.best_moments.map((m) => (
                      <div key={m.rank} className="flex gap-3 p-3 rounded-xl bg-secondary border border-border">
                        <div className="w-7 h-7 shrink-0 rounded-lg bg-primary flex items-center justify-center text-xs font-black text-primary-foreground">
                          {m.rank}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-baseline justify-between gap-3">
                            <h3 className="text-sm font-bold">{m.title}</h3>
                            <span className="text-xs font-bold text-foreground shrink-0">{secondsLabel(m.start_seconds)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{m.why || m.focus}</p>
                          {m.watch_url && (
                            <a
                              href={m.watch_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 mt-2 text-[11px] font-bold text-foreground bg-card border border-border rounded-full px-2 py-1 hover:border-foreground/30 transition-colors no-underline"
                            >
                              <ExternalLink size={10} />
                              Open video
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid sm:grid-cols-2 gap-3">
                  {analysis.key_details.length > 0 && (
                    <div className="p-3 rounded-xl bg-secondary border border-border">
                      <h3 className="text-xs font-bold mb-2 text-emerald-600">Key Details</h3>
                      <ul className="space-y-1">
                        {analysis.key_details.map((d, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <span className="text-emerald-600 mt-0.5">·</span>
                            {d}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {analysis.caveats.length > 0 && (
                    <div className="p-3 rounded-xl bg-secondary border border-border">
                      <h3 className="text-xs font-bold mb-2 text-amber-600">Caveats</h3>
                      <ul className="space-y-1">
                        {analysis.caveats.map((c, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <span className="text-amber-600 mt-0.5">·</span>
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {analysis.study_order.length > 0 && (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Study Order</p>
                    <ol className="space-y-1.5">
                      {analysis.study_order.map((s, i) => (
                        <li key={i} className="flex gap-2.5 text-sm text-foreground/75">
                          <span className="w-5 h-5 shrink-0 rounded-full bg-secondary border border-border text-[11px] font-black flex items-center justify-center">
                            {i + 1}
                          </span>
                          {s}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {analysis.next_searches.length > 0 && (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Lightbulb size={12} />
                      Suggested Searches
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {analysis.next_searches.map((s, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => useExample(s)}
                          className="text-xs font-semibold text-foreground bg-secondary border border-border rounded-full px-3 py-1.5 hover:border-foreground/30 transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Results */}
            {tab === "search" && <div className="space-y-3">
              {loading && results.length === 0 && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-10">
                  <Loader2 size={16} className="animate-spin" />
                  Searching…
                </div>
              )}
              {!loading && searchedQuery && results.length === 0 && !error && (
                <div className="text-sm text-muted-foreground text-center py-10">No results for &quot;{searchedQuery}&quot;.</div>
              )}
              {results.map((r) => {
                const source = r.metadata?.channel_name || r.metadata?.instructor_name || r.metadata?.platform || r.video_id;
                return (
                  <article
                    key={r.id}
                    className="flex gap-4 p-5 rounded-2xl border border-border bg-card hover:border-foreground/20 transition-colors shadow-sm group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="text-[15px] font-bold leading-tight">{titleFor(r)}</h2>
                        <span className="text-xs font-black text-foreground shrink-0 tabular-nums">{scoreFor(r)}</span>
                      </div>
                      <p className="text-sm text-foreground/70 leading-relaxed mt-2 mb-3 line-clamp-4">{r.text}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1 text-[11px] font-bold text-muted-foreground bg-secondary rounded-full px-2.5 py-1">
                          <BookOpen size={10} />
                          {source}
                        </span>
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground bg-secondary rounded-full px-2.5 py-1">
                          <Clock size={10} />
                          {secondsLabel(r.start_seconds)}–{secondsLabel(r.end_seconds)}
                        </span>
                        {r.metadata?.platform && (
                          <span className="text-[11px] text-muted-foreground bg-secondary rounded-full px-2.5 py-1">{r.metadata.platform}</span>
                        )}
                      </div>
                    </div>
                    {r.metadata?.video_url && (
                      <a
                        href={timestampUrl(r.metadata.video_url, Number(r.start_seconds) || 0) ?? r.metadata.video_url}
                        target="_blank"
                        rel="noreferrer"
                        className="self-start flex items-center justify-center w-9 h-9 shrink-0 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                        aria-label={`Open ${titleFor(r)}`}
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                  </article>
                );
              })}
            </div>}
          </div>
        ) : tab === "compare" ? (
          <InstructorCompare providers={providers} />
        ) : tab === "map" ? (
          <SystemMap onExample={useExample} />
        ) : (
          <LangTests />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Search; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
          : "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
      }
    >
      <Icon size={15} />
      <span>{label}</span>
    </button>
  );
}

function ActionButton({
  onClick,
  loading,
  icon: Icon,
  label,
  tooltip,
}: {
  onClick: () => void;
  loading: boolean;
  icon: typeof Search;
  label: string;
  tooltip: string;
}) {
  const tooltipId = useId();

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-describedby={tooltipId}
        className="flex items-center gap-2 px-4 py-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground hover:border-foreground/30 transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
        {label}
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-center text-xs font-medium leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tooltip}
      </span>
    </div>
  );
}

function EngineComparison({ comparison }: { comparison: NonNullable<Comparison> }) {
  const { classic, graph } = comparison;
  const faster = classic.clientMs <= graph.clientMs ? "classic" : "langgraph";
  const delta = Math.abs(classic.clientMs - graph.clientMs);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent/12 flex items-center justify-center">
            <GitCompareArrows size={14} className="text-accent" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">Engine Comparison</h2>
            <p className="text-[11px] text-muted-foreground">Same query, same corpus — classic pipeline vs LangGraph</p>
          </div>
        </div>
        <span className="text-[11px] font-bold text-muted-foreground bg-secondary rounded-full px-2.5 py-1 shrink-0">
          {faster === "classic" ? "Classic" : "LangGraph"} faster by {delta}ms
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <EngineColumn result={classic} highlight={faster === "classic"} />
        <EngineColumn result={graph} highlight={faster === "langgraph"} />
      </div>

      <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
        Both engines share the same Supabase retrieval RPCs, RRF fusion, diversity cap, LLM rerank, and answer contract.
        Only the orchestration differs: the classic engine is hand-wired on the OpenAI SDK; the LangGraph engine runs the
        same stages as a compiled <code className="bg-secondary rounded px-1">StateGraph</code> using LangChain runnables.
      </p>
    </div>
  );
}

function VideoReferences({
  citations,
  compact = false,
}: {
  citations: RagAnswerCitation[];
  compact?: boolean;
}) {
  if (citations.length === 0) return null;

  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">
          Video references
        </p>
      )}
      <div className={compact ? "grid gap-1.5" : "grid gap-2 sm:grid-cols-2"}>
        {citations.map((citation, index) => (
          <a
            key={`${citation.citation}-${index}`}
            href={citation.watch_url ?? undefined}
            target={citation.watch_url ? "_blank" : undefined}
            rel="noreferrer"
            aria-label={`${citation.title}, relevant segment ${timestampRangeLabel(citation.start_seconds, citation.end_seconds)}`}
            className="group flex min-w-0 items-center gap-2.5 overflow-hidden rounded-xl border border-border bg-secondary p-1.5 text-foreground no-underline transition-colors hover:border-foreground/30"
          >
            <span className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/10 text-foreground/70">
              <Play size={15} fill="currentColor" aria-hidden="true" />
              {citation.thumbnail_url && (
                // Plain img supports the corpus' mixed thumbnail hosts without
                // widening Next Image's remote-host allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={citation.thumbnail_url}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(event) => { event.currentTarget.style.display = "none"; }}
                />
              )}
              <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 text-[9px] font-bold leading-none text-white">
                {timestampRangeLabel(citation.start_seconds, citation.end_seconds)}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-xs font-bold leading-snug">{citation.title}</span>
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                {citation.channel || "Watch video"}
              </span>
            </span>
            {citation.watch_url && <ExternalLink size={12} className="mr-1 shrink-0 text-muted-foreground group-hover:text-foreground" />}
          </a>
        ))}
      </div>
    </div>
  );
}

function EngineColumn({ result, highlight }: { result: EngineResult; highlight: boolean }) {
  const answer = result.answer;
  const isGraph = result.engine === "langgraph";
  return (
    <div
      className={
        highlight
          ? "rounded-xl border-2 border-accent/40 bg-secondary/50 p-4 space-y-3"
          : "rounded-xl border border-border bg-secondary/50 p-4 space-y-3"
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-card border border-border flex items-center justify-center">
            {isGraph ? <Workflow size={12} className="text-foreground" /> : <Cpu size={12} className="text-foreground" />}
          </div>
          <div>
            <h3 className="text-sm font-bold leading-tight">{result.label}</h3>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{result.sublabel}</p>
          </div>
        </div>
        <span className="flex items-center gap-1 text-[11px] font-black text-foreground bg-card border border-border rounded-full px-2 py-1 shrink-0 tabular-nums">
          <Timer size={10} />
          {result.clientMs}ms
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip>{result.model}</Chip>
        <Chip>{result.retrieval}</Chip>
        <Chip>{result.sourceCount} sources</Chip>
        <Chip>{result.reranked ? "reranked" : "no rerank"}</Chip>
      </div>

      <p className="text-sm leading-relaxed text-foreground/85 whitespace-pre-line">{answer.answer}</p>

      {answer.key_takeaways.length > 0 && (
        <ul className="space-y-1">
          {answer.key_takeaways.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-foreground/75">
              <span className="text-accent mt-0.5">·</span>
              {t}
            </li>
          ))}
        </ul>
      )}

      <VideoReferences citations={answer.citations} compact />

      {isGraph && result.trace && result.trace.length > 0 && (
        <div className="pt-1 border-t border-border">
          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
            <Workflow size={11} />
            Graph node trace
          </p>
          <ol className="space-y-1">
            {result.trace.map((node, i) => (
              <li key={node.node} className="flex items-center gap-2 text-[11px]">
                <span className="w-4 h-4 shrink-0 rounded bg-card border border-border text-[9px] font-black flex items-center justify-center tabular-nums">
                  {i + 1}
                </span>
                <span className="font-bold text-foreground">{node.label}</span>
                <span className="text-muted-foreground truncate flex-1">{node.detail}</span>
                <span className="text-foreground font-bold tabular-nums shrink-0">{node.ms}ms</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {answer.caveats.length > 0 && (
        <p className="text-[11px] text-muted-foreground pt-1 border-t border-border">{answer.caveats.join(" · ")}</p>
      )}
    </div>
  );
}

function AnswerUsage({
  provider,
  model,
  usage,
}: {
  provider: AnswerProvider;
  model: string;
  usage: RagTokenUsage | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
      <span>
        Answer model: <strong className="font-bold text-foreground/75">{PROVIDER_META[provider].label} · {model}</strong>
      </span>
      {usage ? (
        <span title="Answer-generation tokens only; retrieval embedding and reranking usage are separate.">
          <strong className="font-bold text-foreground/75">{usage.total_tokens.toLocaleString()}</strong> generation tokens
          {` · ${usage.prompt_tokens.toLocaleString()} prompt + ${usage.completion_tokens.toLocaleString()} output`}
        </span>
      ) : (
        <span>Token usage not reported</span>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-bold text-muted-foreground bg-card border border-border rounded-full px-2 py-0.5">
      {children}
    </span>
  );
}

/* ---- System Map: how the two engines are wired ---- */
function EngineArchitecture() {
  return (
    <>
      {/* Two engines, one pipeline */}
      <section className="p-5 rounded-2xl border border-border bg-card shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent/12 flex items-center justify-center">
            <GitCompareArrows size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">Two Orchestration Engines</p>
            <h2 className="text-lg font-bold leading-tight">Same pipeline, wired two ways</h2>
          </div>
        </div>
        <p className="text-sm text-foreground/65 leading-relaxed">
          Both engines run the <span className="font-bold text-foreground">identical retrieval math</span> — embed, hybrid search,
          RRF fusion, diversity cap, LLM rerank, cited generation. What differs is <span className="font-bold text-foreground">how the
          stages are wired together</span>. The <span className="font-bold text-foreground">Compare Engines</span> button on the Search
          tab runs both on one query so you can diff them.
        </p>
        <div className="grid md:grid-cols-2 gap-3">
          {ENGINES.map((e) => {
            const Icon = e.icon;
            const accent = e.key === "langgraph";
            return (
              <div
                key={e.key}
                className={
                  accent
                    ? "rounded-xl border-2 border-accent/40 bg-secondary/50 p-4 space-y-3"
                    : "rounded-xl border border-border bg-secondary/50 p-4 space-y-3"
                }
              >
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center">
                    <Icon size={15} className="text-foreground" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold leading-tight">{e.name}</h3>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{e.sub}</p>
                  </div>
                </div>
                <p className="text-xs text-foreground/70 leading-relaxed">{e.how}</p>
                <ul className="space-y-1.5">
                  {e.points.map((p, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <span className={accent ? "text-accent mt-0.5" : "text-muted-foreground mt-0.5"}>·</span>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* LangGraph StateGraph */}
      <section className="p-5 rounded-2xl border border-border bg-card shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-secondary flex items-center justify-center">
            <Workflow size={14} className="text-foreground" />
          </div>
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">LangGraph StateGraph</p>
            <h2 className="text-lg font-bold leading-tight">How the graph executes</h2>
          </div>
        </div>
        <p className="text-sm text-foreground/65 leading-relaxed">
          The graph is <span className="font-bold text-foreground">compiled once</span>, then <code className="text-foreground bg-secondary rounded px-1 text-xs">invoke()</code> walks
          it node by node. Each node reads the shared state and returns only the fields it changed; the framework merges those updates
          and moves to the next edge.
        </p>

        <NodeFlow />

        <div className="grid sm:grid-cols-3 gap-3 pt-1">
          {LG_CONCEPTS.map((c) => {
            const Icon = c.icon;
            return (
              <div key={c.term} className="p-3 rounded-xl bg-secondary border border-border">
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon size={13} className="text-accent" />
                  <strong className="text-xs font-black text-foreground">{c.term}</strong>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{c.def}</p>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

// Vertical node-flow diagram of the compiled LangGraph: START → retrieve → fuse
// →(conditional)→ rerank → enrich → generate → END.
function NodeFlow() {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-4 sm:p-5">
      <div className="flex flex-col items-stretch">
        <FlowCap label="START" tone="start" />
        <Connector />
        {GRAPH_NODES.map((n, i) => {
          const Icon = n.icon;
          return (
            <div key={n.id}>
              <div className="flex gap-3 items-start rounded-xl border border-border bg-card p-3 shadow-sm">
                <div className="w-8 h-8 shrink-0 rounded-lg bg-secondary border border-border flex items-center justify-center text-foreground">
                  <Icon size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-[13px] font-black text-foreground">{n.id}()</code>
                    <span className="text-[10px] font-bold text-accent bg-accent/10 rounded-full px-2 py-0.5">{n.tech}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">{n.desc}</p>
                </div>
              </div>
              {n.id === "fuse" ? <ConditionalConnector /> : i < GRAPH_NODES.length - 1 ? <Connector /> : null}
            </div>
          );
        })}
        <Connector />
        <FlowCap label="END" tone="end" />
      </div>
    </div>
  );
}

function ProviderSelector({
  providers,
  selected,
  onSelect,
}: {
  providers: ProviderInfo[];
  selected: AnswerProvider | "";
  onSelect: (provider: AnswerProvider) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        <Cpu size={12} />
        Answer engine
      </span>
      <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-secondary border border-border">
        {providers.map((p) => {
          const active = selected === p.id;
          const tooltip = p.available
            ? `${PROVIDER_META[p.id].blurb} Model: ${p.model}.`
            : `${PROVIDER_META[p.id].label} is not available on this host.`;
          return (
            <div key={p.id} className="group/provider relative">
              <button
                type="button"
                onClick={() => p.available && onSelect(p.id)}
                disabled={!p.available}
                aria-describedby={`provider-${p.id}-tooltip`}
                className={
                  active
                    ? "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold"
                    : p.available
                      ? "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-foreground hover:bg-muted transition-colors"
                      : "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-muted-foreground/50 cursor-not-allowed"
                }
              >
                {PROVIDER_META[p.id].label}
                {!p.available && <span className="text-[10px] font-normal">· off</span>}
              </button>
              <span
                id={`provider-${p.id}-tooltip`}
                role="tooltip"
                className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-64 -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-center text-xs font-medium leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover/provider:opacity-100 group-focus-within/provider:opacity-100"
              >
                {tooltip}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center py-1" aria-hidden>
      <div className="flex flex-col items-center">
        <div className="w-px h-3 bg-border" />
        <ChevronDown size={13} className="text-muted-foreground -mt-1" />
      </div>
    </div>
  );
}

// The one conditional edge in the graph: skip straight to END on empty retrieval.
function ConditionalConnector() {
  return (
    <div className="flex justify-center py-1.5">
      <div className="flex items-center gap-2 rounded-full border border-dashed border-accent/50 bg-accent/5 px-3 py-1 flex-wrap justify-center">
        <GitBranch size={11} className="text-accent shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-wider text-foreground">conditional edge</span>
        <span className="text-[10px] text-muted-foreground">
          sources &gt; 0 → <code className="text-foreground font-bold">rerank</code> · else → <code className="text-foreground font-bold">END</code> (404)
        </span>
      </div>
    </div>
  );
}

function FlowCap({ label, tone }: { label: string; tone: "start" | "end" }) {
  return (
    <div className="flex justify-center">
      <span
        className={
          tone === "start"
            ? "text-[10px] font-black uppercase tracking-widest text-accent bg-accent/10 border border-accent/30 rounded-full px-3 py-1"
            : "text-[10px] font-black uppercase tracking-widest text-muted-foreground bg-secondary border border-border rounded-full px-3 py-1"
        }
      >
        {label}
      </span>
    </div>
  );
}

function Banner({ tone, children }: { tone: "error"; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">{children}</div>
  );
}

function SystemMap({ onExample }: { onExample: (q: string) => void }) {
  return (
    <div className="space-y-4">
      {/* Overview band */}
      <section className="grid md:grid-cols-[1.4fr_0.9fr] gap-5 items-center p-6 rounded-2xl border border-border bg-card shadow-sm">
        <div>
          <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground mb-2">Current Build</p>
          <h2 className="text-2xl font-bold leading-snug text-balance">Searchable transcript evidence with hybrid retrieval and cited answers</h2>
          <p className="mt-3 text-sm text-foreground/65 leading-relaxed max-w-xl">
            The app reads the <code className="text-foreground bg-secondary rounded px-1 text-xs">rag_</code> tables, retrieves transcript chunks
            with citations, embeds the full corpus for meaning search, and generates answers only from retrieved sources.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2.5" aria-label="Corpus summary">
          {METRICS.map((m) => (
            <div key={m.label} className="p-3.5 rounded-xl border border-border bg-secondary flex flex-col gap-1">
              <strong className="text-2xl font-black text-foreground leading-none">{m.value}</strong>
              <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">{m.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Pipeline */}
      <section className="p-5 rounded-2xl border border-border bg-card shadow-sm">
        <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground mb-4">RAG Pipeline</p>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
          {PIPELINE.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.step} className="relative flex sm:flex-col gap-3 p-4 rounded-xl border border-border bg-secondary hover:border-foreground/20 transition-colors">
                <div className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center bg-card border border-border text-foreground">
                  <Icon size={18} />
                </div>
                <div className="min-w-0">
                  <span className="block text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1">
                    {step.step} · {step.label}
                  </span>
                  <h3 className="text-sm font-bold leading-snug">{step.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1 hidden sm:block">{step.desc}</p>
                  <span className="inline-block mt-2 text-[10px] font-black rounded-full px-2 py-0.5 bg-card text-foreground border border-border">
                    {step.tag}
                  </span>
                </div>
                {i < PIPELINE.length - 1 && (
                  <ChevronRight size={14} className="absolute -right-2 top-1/2 -translate-y-1/2 text-border hidden sm:block z-10" />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Engine architecture */}
      <EngineArchitecture />

      {/* How it works + Use cases */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="p-5 rounded-2xl border border-border bg-card shadow-sm">
          <h3 className="text-base font-bold mb-3">How It Works</h3>
          <ol className="space-y-2.5">
            {EXPLAIN_STEPS.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm text-foreground/70 leading-relaxed">
                <span className="w-5 h-5 shrink-0 rounded-full bg-secondary border border-border text-[11px] font-black flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </section>

        <section className="p-5 rounded-2xl border border-border bg-card shadow-sm">
          <h3 className="text-base font-bold mb-3">Use Cases</h3>
          <div className="grid grid-cols-2 gap-2.5">
            {USE_CASES.map((uc) => {
              const Icon = uc.icon;
              return (
                <div key={uc.title} className="p-3 rounded-xl bg-secondary border border-border">
                  <div className="w-7 h-7 rounded-lg bg-card border border-border flex items-center justify-center mb-2">
                    <Icon size={14} className="text-foreground" />
                  </div>
                  <strong className="block text-sm font-bold text-foreground mb-1">{uc.title}</strong>
                  <span className="text-xs text-muted-foreground leading-relaxed">{uc.desc}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Pitch */}
      <section className="grid md:grid-cols-[1.2fr_0.8fr] gap-5 items-center p-6 rounded-2xl border border-border bg-card shadow-sm">
        <div>
          <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground mb-2">Why It Works</p>
          <h2 className="text-xl font-bold leading-snug text-balance">Grounded answers from every clip in the corpus</h2>
          <p className="mt-3 text-sm text-foreground/65 leading-relaxed">
            No hallucination, no guessing. Every answer is built from verbatim transcript evidence with pinpoint timestamps.
          </p>
        </div>
        <div className="space-y-2.5">
          {PITCH_LINES.map((line, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-secondary">
              <CheckCircle2 size={16} className="text-accent shrink-0" />
              <span className="text-sm font-bold">{line}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Evaluated queries */}
      <section className="p-5 rounded-2xl border border-border bg-card shadow-sm space-y-4">
        <h3 className="text-base font-bold">Evaluated Queries</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {EVAL_STRIP.map((e) => (
            <div key={e.label} className="p-3 rounded-xl border border-border bg-secondary">
              <strong className="block text-base font-black text-foreground">{e.value}</strong>
              <span className="block text-[11px] font-bold text-muted-foreground mt-1">{e.label}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Click a query to run it live:</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {["knee cut", "saddle", "crossface", "guard retention", "heel hook", "triangle choke", "mount escape", "rear naked choke", "omoplata"].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onExample(q)}
              className="p-3 rounded-xl border border-border bg-secondary text-left hover:border-foreground/30 transition-colors"
            >
              <span className="block text-sm font-semibold leading-snug">{q}</span>
              <span className="block text-[11px] text-muted-foreground mt-1.5">run search →</span>
            </button>
          ))}
        </div>
      </section>

      {/* Table map */}
      <section className="p-5 rounded-2xl border border-border bg-card shadow-sm space-y-4">
        <div>
          <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground mb-1">Schema</p>
          <h2 className="text-lg font-bold">Database Table Map</h2>
        </div>
        <div className="space-y-2">
          {TABLE_ROWS.map((row) => (
            <div key={row.table} className="grid grid-cols-[minmax(150px,0.9fr)_64px_72px_minmax(0,1.6fr)] gap-3 items-center p-3 rounded-xl border border-border bg-secondary">
              <code className="text-sm font-black text-foreground truncate">{row.table}</code>
              <strong className="text-sm font-black text-foreground tabular-nums">{row.count}</strong>
              <span
                className={
                  row.type === "Core"
                    ? "text-[11px] font-bold rounded-full px-2 py-0.5 text-center bg-card text-foreground border border-border"
                    : row.type === "Vectors"
                      ? "text-[11px] font-bold rounded-full px-2 py-0.5 text-center bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : row.type === "Logs"
                        ? "text-[11px] font-bold rounded-full px-2 py-0.5 text-center bg-amber-50 text-amber-700 border border-amber-200"
                        : "text-[11px] font-bold rounded-full px-2 py-0.5 text-center bg-secondary text-muted-foreground border border-border"
                }
              >
                {row.type}
              </span>
              <span className="text-xs text-muted-foreground leading-relaxed">{row.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Model provider usage */}
      <section className="p-5 rounded-2xl border border-border bg-card shadow-sm space-y-4">
        <div>
          <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground mb-1">Providers</p>
          <h2 className="text-lg font-bold">Model Usage by App Action</h2>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            The Ask AI provider controls final-answer generation. With an OpenAI key configured, retrieval can still use OpenAI embeddings and reranking.
          </p>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-secondary text-[11px] font-black uppercase tracking-wider text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3">App action</th>
                <th scope="col" className="px-4 py-3">Uses LLM?</th>
                <th scope="col" className="px-4 py-3">Local Qwen / Claude</th>
                <th scope="col" className="px-4 py-3">OpenRouter</th>
                <th scope="col" className="px-4 py-3">OpenAI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MODEL_USAGE_ROWS.map((row) => (
                <tr key={row.action} className="bg-card">
                  <th scope="row" className="px-4 py-3 font-bold text-foreground">{row.action}</th>
                  <td className="px-4 py-3 font-semibold text-foreground/80">{row.usesLlm}</td>
                  <td className="px-4 py-3 text-foreground/70">{row.local}</td>
                  <td className="px-4 py-3 text-foreground/70">{row.openrouter}</td>
                  <td className="px-4 py-3 text-foreground/70">{row.openai}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
