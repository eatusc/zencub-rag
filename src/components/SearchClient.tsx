"use client";

import {
  BarChart3,
  BookOpen,
  Brain,
  ChevronRight,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Dumbbell,
  ExternalLink,
  Lightbulb,
  Link2,
  ListOrdered,
  Loader2,
  MessageSquare,
  Search,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type {
  RagAnalysis,
  RagAnalyzeResponse,
  RagAnswer,
  RagAskResponse,
  RagSearchResponse,
  RagSearchResult,
} from "@/lib/types";
import { timestampUrl } from "@/lib/ragUtils";

function secondsLabel(value: number | string | null | undefined) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric ?? NaN)) return "0:00";
  const total = Math.max(0, Math.floor(numeric as number));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function titleFor(result: RagSearchResult) {
  return result.metadata?.video_title || result.video_id;
}

function scoreFor(result: RagSearchResult) {
  const raw = result.similarity ?? result.rank ?? 0;
  return raw.toFixed(2);
}

type Tab = "search" | "map";
type Mode = "keyword" | "semantic";

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

const TABLE_ROWS: Array<{ table: string; count: string; type: "Core" | "Meta" | "Vectors"; desc: string }> = [
  { table: "rag_videos", count: "2,402", type: "Core", desc: "Video title, source URL, platform, channel, thumbnail, slug." },
  { table: "rag_video_transcripts", count: "2,298", type: "Core", desc: "Raw transcript JSON segments and transcript metadata." },
  { table: "rag_techniques", count: "2,844", type: "Meta", desc: "Technique names, positions, summaries, steps, timestamps." },
  { table: "rag_creators", count: "468", type: "Meta", desc: "Canonical creator names, aliases, opt-out field." },
  { table: "rag_transcript_chunks", count: "12,104", type: "Vectors", desc: "Searchable timestamped chunks + embedding vectors." },
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
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RagAnalysis | null>(null);
  const [analysisModel, setAnalysisModel] = useState("");
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [answerModel, setAnswerModel] = useState("");
  const [answerRetrieval, setAnswerRetrieval] = useState<"vector" | "text" | "hybrid" | "">("");

  async function runSearch(trimmed: string) {
    setLoading(true);
    setMode("keyword");
    setError(null);
    setActionError(null);
    setAnalysis(null);
    setAnswer(null);
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

  async function askQuestion() {
    const trimmed = searchedQuery || query.trim();
    if (trimmed.length < 2) return;
    setAskLoading(true);
    setActionError(null);
    try {
      const res = await fetch("/api/rag/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, retrieval: "auto" }),
      });
      const payload = (await res.json()) as RagAskResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Ask failed");
      setAnswer(payload.answer);
      setAnswerModel(payload.model);
      setAnswerRetrieval(payload.retrieval);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Ask failed");
      setAnswer(null);
    } finally {
      setAskLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    void runSearch(trimmed);
  }

  function useExample(next: string) {
    setQuery(next);
    setTab("search");
    void runSearch(next);
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
        <div className="flex gap-1 p-1 rounded-xl bg-secondary border border-border w-fit mb-5">
          <TabButton active={tab === "search"} onClick={() => setTab("search")} icon={Search} label="Search" />
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={Workflow} label="System Map" />
        </div>

        {tab === "search" ? (
          <div className="space-y-4">
            {/* Search bar */}
            <form onSubmit={submit} className="flex items-center gap-3 px-4 sm:px-5 py-3 rounded-2xl bg-card border border-border shadow-sm">
              <Search className="shrink-0 text-muted-foreground" size={19} />
              <input
                className="flex-1 min-w-0 bg-transparent text-foreground placeholder:text-muted-foreground text-[15px] outline-none"
                placeholder="Search knee cut, saddle entries, crossface details..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search transcript chunks"
              />
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {loading && mode === "keyword" ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                <span>Search</span>
              </button>
            </form>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
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
                onClick={askQuestion}
                loading={askLoading}
                icon={MessageSquare}
                label="Ask AI"
                tooltip="Use hybrid retrieval to generate an answer grounded in transcript sources, with citations."
              />
            </div>

            {/* Summary row */}
            {searchedQuery && (
              <div className="flex justify-between items-center text-xs text-muted-foreground px-1">
                <span>
                  {results.length} result{results.length === 1 ? "" : "s"} for{" "}
                  <span className="text-foreground font-semibold">&quot;{searchedQuery}&quot;</span>
                </span>
                <span>{mode === "semantic" ? "Semantic · cosine similarity" : "Keyword · full-text"}</span>
              </div>
            )}

            {error && <Banner tone="error">{error}</Banner>}
            {actionError && <Banner tone="error">{actionError}</Banner>}

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
                  <span className="text-[11px] font-bold text-muted-foreground bg-secondary rounded-full px-2.5 py-1 shrink-0">
                    {answerModel}
                    {answerRetrieval ? ` · ${answerRetrieval}` : ""}
                  </span>
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

                {answer.citations.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {answer.citations.map((c, i) => (
                      <a
                        key={i}
                        href={c.watch_url ?? "#"}
                        target={c.watch_url ? "_blank" : undefined}
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-[11px] font-bold text-foreground bg-secondary rounded-lg px-2.5 py-1.5 hover:bg-muted transition-colors no-underline"
                      >
                        <Link2 size={10} />
                        {c.title}
                        {c.start_seconds ? ` — ${secondsLabel(c.start_seconds)}` : ""}
                      </a>
                    ))}
                  </div>
                )}

                {answer.follow_up_searches.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {answer.follow_up_searches.map((s, i) => (
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
                )}

                {answer.caveats.length > 0 && (
                  <p className="text-xs text-muted-foreground pt-1 border-t border-border">
                    {answer.caveats.join(" · ")}
                  </p>
                )}
              </div>
            )}

            {/* Corpus Analysis */}
            {analysis && (
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
            <div className="space-y-3">
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
            </div>
          </div>
        ) : (
          <SystemMap onExample={useExample} />
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
    </div>
  );
}
