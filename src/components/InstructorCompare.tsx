"use client";

import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Lightbulb,
  Loader2,
  Network,
  Play,
  Search,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { AnswerProvider, ProviderInfo } from "@/lib/providers";
import type {
  RagAnswerCitation,
  RagGraphTraceEntry,
  RagInstructorCompareResponse,
} from "@/lib/types";

const EXAMPLES = [
  "Compare how instructors defend the knee cut after the passer wins the crossface",
  "Compare different approaches to escaping mount when the opponent stays low",
  "Compare how instructors teach guard retention against a standing passer",
  "Compare approaches to defending heel hooks safely",
];

const GUIDE = [
  { icon: Search, title: "Ask one situational question", detail: "Describe the exact position or problem—not an instructor name." },
  { icon: Network, title: "Retrieve in parallel", detail: "Enabled retrieval branches fan out independently; free local mode skips paid semantic embeddings." },
  { icon: Users, title: "Build a fair panel", detail: "Canonical attribution groups evidence and prevents one instructor from dominating." },
  { icon: GitBranch, title: "Analyze independently", detail: "LangGraph creates one parallel branch per instructor with only that instructor’s evidence." },
  { icon: Workflow, title: "Converge and compare", detail: "The branches join to identify supported consensus, differences, and situational choices." },
  { icon: ShieldCheck, title: "Validate every claim", detail: "Consensus and differences survive only when citations cover at least two instructors." },
] as const;

function seconds(value: number) {
  const total = Math.max(0, Math.floor(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const COMPARE_PROVIDERS: AnswerProvider[] = ["qwen", "openrouter", "openai"];

export function InstructorCompare({ providers }: { providers: ProviderInfo[] }) {
  const [query, setQuery] = useState(EXAMPLES[0]);
  const [instructorCount, setInstructorCount] = useState(3);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [result, setResult] = useState<RagInstructorCompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AnswerProvider>("openrouter");
  const [runs, setRuns] = useState<RagInstructorCompareResponse[]>([]);

  const compareProviders = COMPARE_PROVIDERS.map((id) => providers.find((item) => item.id === id)).filter((item): item is ProviderInfo => Boolean(item));
  const selectedProvider = compareProviders.find((item) => item.id === provider);

  useEffect(() => {
    if (selectedProvider?.available) return;
    const fallback = compareProviders.find((item) => item.id === "openrouter" && item.available)
      ?? compareProviders.find((item) => item.id === "qwen" && item.available)
      ?? compareProviders.find((item) => item.available);
    if (fallback) setProvider(fallback.id);
  }, [compareProviders, selectedProvider]);

  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }
    const timer = window.setInterval(() => setLoadingStep((step) => Math.min(step + 1, GUIDE.length - 1)), 1600);
    return () => window.clearInterval(timer);
  }, [loading]);

  async function runComparison(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const response = await fetch("/api/rag/instructor-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, instructor_count: instructorCount, provider }),
      });
      const payload = await response.json() as RagInstructorCompareResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Instructor comparison failed.");
      setResult(payload);
      setRuns((previous) => [payload, ...previous].slice(0, 6));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Instructor comparison failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="grid gap-5 p-6 md:grid-cols-[1.25fr_0.75fr] md:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-accent">Live LangGraph workflow</span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[10px] font-bold text-muted-foreground">1,044 person-attributed videos</span>
            </div>
            <h2 className="mt-3 text-2xl font-bold leading-tight text-balance">Compare instructors without watching dozens of videos first</h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/65">Ask about one BJJ situation. The graph finds distinct instructors, analyzes each from their own timestamped evidence, then shows where their approaches agree, differ, and fit.</p>
          </div>
          <div className="rounded-xl border border-border bg-secondary/60 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Why LangGraph here?</p>
            <p className="mt-2 text-xs leading-relaxed text-foreground/75">The value is not merely asking a model to compare text. It is making retrieval, attribution, parallel analysis, convergence, validation, checkpoints, and failures independently visible and controllable.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-4">
          <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">Choose the model</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {compareProviders.map((item) => {
              const active = provider === item.id;
              const detail = item.id === "qwen" ? "Free · local" : item.id === "openrouter" ? "Paid API · quality default" : "Paid API · GPT-4o Mini";
              return <button key={item.id} type="button" disabled={!item.available || loading} onClick={() => setProvider(item.id)} className={`rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${active ? "border-accent bg-accent/5 ring-1 ring-accent/20" : "border-border bg-secondary/40"}`}>
                <span className="block text-xs font-black">{item.label}{item.id === "openrouter" && <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] text-emerald-700">DEFAULT</span>}</span>
                <span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground" title={item.model}>{item.model}</span>
                <span className="mt-1 block text-[9px] font-bold text-muted-foreground">{item.available ? detail : "Unavailable"}</span>
              </button>;
            })}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Qwen3 235B is the quality default. Local Qwen remains the zero-paid option: semantic OpenAI embeddings are disabled, and retrieval uses database keyword + technique metadata. Every result reports the exact model, elapsed time, and model-reported tokens.</p>
        </div>
        <form onSubmit={runComparison}>
          <label htmlFor="instructor-compare-query" className="text-xs font-black uppercase tracking-wider text-muted-foreground">What position or problem should instructors be compared on?</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <textarea
              id="instructor-compare-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-h-20 flex-1 resize-none rounded-xl border border-border bg-secondary/40 px-4 py-3 text-sm leading-relaxed outline-none focus:border-foreground/30"
            />
            <div className="flex shrink-0 flex-row gap-2 sm:w-40 sm:flex-col">
              <label className="flex flex-1 flex-col gap-1 text-[10px] font-bold text-muted-foreground">
                Instructor panel
                <select value={instructorCount} onChange={(event) => setInstructorCount(Number(event.target.value))} className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold text-foreground outline-none">
                  {[2, 3, 4, 5].map((count) => <option key={count} value={count}>{count} instructors</option>)}
                </select>
              </label>
              <button type="submit" disabled={loading || query.trim().length < 2 || !selectedProvider?.available} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground disabled:opacity-60">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}{loading ? "Comparing…" : "Compare"}
              </button>
            </div>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((example, index) => (
            <button key={example} type="button" onClick={() => setQuery(example)} className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[10px] font-bold text-muted-foreground hover:text-foreground">Example {index + 1}</button>
          ))}
        </div>
      </section>

      <GuideProgress activeStep={loading ? loadingStep : result ? GUIDE.length : 0} running={loading} complete={Boolean(result)} />

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {result && <ComparisonResult result={result} />}
      {runs.length > 1 && <RunHistory runs={runs} />}
    </div>
  );
}

function GuideProgress({ activeStep, running, complete }: { activeStep: number; running: boolean; complete: boolean }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Guided execution</p><h2 className="text-base font-bold">Watch the graph turn one question into a defensible comparison</h2></div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${complete ? "border-emerald-200 bg-emerald-50 text-emerald-700" : running ? "border-amber-200 bg-amber-50 text-amber-700" : "border-border bg-secondary text-muted-foreground"}`}>{complete ? "Run complete" : running ? `Step ${activeStep + 1} of ${GUIDE.length}` : "Ready"}</span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {GUIDE.map((step, index) => {
          const Icon = step.icon;
          const done = complete || running && index < activeStep;
          const active = running && index === activeStep;
          return (
            <div key={step.title} className={`rounded-xl border p-3 transition-colors ${done ? "border-emerald-200 bg-emerald-50/60" : active ? "border-accent bg-accent/5 ring-1 ring-accent/20" : "border-border bg-secondary/40"}`}>
              <div className="flex items-center gap-2">{done ? <CheckCircle2 size={14} className="text-emerald-600" /> : active ? <Loader2 size={14} className="animate-spin text-accent" /> : <Icon size={14} className="text-muted-foreground" />}<span className="text-xs font-bold">{step.title}</span></div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">{step.detail}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ComparisonResult({ result }: { result: RagInstructorCompareResponse }) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Grounded comparison</p><h2 className="mt-1 text-xl font-bold">{result.comparison.topic}</h2></div>
          <div className="text-right"><span className="rounded-full border border-emerald-200 bg-card px-3 py-1 text-[10px] font-bold text-emerald-700">{result.model}</span><p className="mt-1.5 text-[9px] font-bold text-emerald-800/70">{result.zero_paid_model_mode ? "Zero paid model calls" : result.provider === "openrouter" ? "OpenRouter API" : "OpenAI API"}</p></div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Metric value={String(result.instructor_count)} label="instructors" />
          <Metric value={String(result.evidence_count)} label="cited videos" />
          <Metric value={String(result.checkpoint_count)} label="checkpoints" />
          <Metric value={`${(result.total_ms / 1000).toFixed(1)}s`} label="total run" />
          <Metric value={result.usage.total_tokens.toLocaleString()} label="total tokens" />
          <Metric value={`${result.usage.prompt_tokens.toLocaleString()} / ${result.usage.completion_tokens.toLocaleString()}`} label="input / output" />
        </div>
        <div className="mt-3 grid gap-1.5 text-[9px] sm:grid-cols-2">
          <ModelStage label="Semantic retrieval" value={result.models.semantic_embedding ? `${result.models.semantic_embedding} → pgvector (embedding tokens not included below)` : "Disabled in zero-paid local mode"} />
          <ModelStage label="Evidence reranker" value={result.models.evidence_reranker ?? "Not invoked; attributed panel was already within the ranking limit"} />
          <ModelStage label="Instructor branches" value={result.models.instructor_analysis} />
          <ModelStage label="Final synthesis" value={result.models.synthesis} />
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-emerald-200 bg-card">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-emerald-100 px-2.5 py-1.5 text-[8px] font-black uppercase tracking-wider text-muted-foreground"><span>Model call</span><span>Time</span><span>Tokens</span></div>
          {result.usage.model_calls.map((call, index) => <div key={`${call.stage}-${index}`} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-emerald-100 px-2.5 py-1.5 text-[9px] last:border-b-0"><span><strong>{call.stage.replaceAll("_", " ")}</strong> · {call.model}</span><span>{(call.ms / 1000).toFixed(1)}s</span><span>{call.total_tokens.toLocaleString()}</span></div>)}
        </div>
        <p className="mt-3 text-[10px] text-emerald-800/75">Canonical attribution covered {result.attribution.attributed_candidates}/{result.attribution.retrieved_candidates} retrieved candidates at confidence ≥ {result.attribution.minimum_confidence}. Thread <span className="font-mono">{result.thread_id}</span>.</p>
      </section>

      {result.comparison.shared_principles.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2"><Users size={15} className="text-accent" /><h2 className="text-base font-bold">What the instructors agree on</h2></div>
          <p className="mt-1 text-[11px] text-muted-foreground">Each retained principle has evidence from at least two instructors.</p>
          <div className="mt-3 space-y-3">
            {result.comparison.shared_principles.map((claim, index) => <ClaimCard key={index} text={claim.summary} citations={claim.citations} />)}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2"><GitBranch size={15} className="text-accent" /><h2 className="text-base font-bold">Independent instructor branches</h2></div>
        <p className="mt-1 text-[11px] text-muted-foreground">Each card was generated in its own LangGraph branch using only that instructor’s selected clips.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {result.comparison.instructors.map((instructor) => (
            <article key={instructor.creator_slug} className="rounded-xl border border-border bg-secondary/40 p-4">
              <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-black">{instructor.creator_name}</h3><p className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Attribution confidence {(instructor.attribution_confidence * 100).toFixed(0)}%</p></div><span className="rounded-full border border-border bg-card px-2 py-0.5 text-[9px] font-bold">parallel branch</span></div>
              <p className="mt-3 text-xs leading-relaxed text-foreground/80">{instructor.approach_summary}</p>
              {instructor.key_details.length > 0 && <DetailList title="Key details" items={instructor.key_details} />}
              {instructor.best_for.length > 0 && <DetailList title="Best fit" items={instructor.best_for} />}
              {instructor.limitations.length > 0 && <DetailList title="Limits / gaps" items={instructor.limitations} muted />}
              <CitationLinks citations={instructor.citations} />
            </article>
          ))}
        </div>
      </section>

      {result.comparison.important_differences.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2"><GitBranch size={15} className="text-accent" /><h2 className="text-base font-bold">Where the approaches differ</h2></div>
          <div className="mt-3 space-y-3">
            {result.comparison.important_differences.map((difference, index) => (
              <div key={`${difference.subject}-${index}`} className="rounded-xl border border-border bg-secondary/40 p-4">
                <div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-black">{difference.subject}</h3>{difference.instructor_names.map((name) => <span key={name} className="rounded-full bg-card px-2 py-0.5 text-[9px] font-bold text-muted-foreground">{name}</span>)}</div>
                <p className="mt-2 text-xs leading-relaxed text-foreground/75">{difference.explanation}</p>
                <CitationLinks citations={difference.citations} />
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2"><Lightbulb size={15} className="text-accent" /><h2 className="text-base font-bold">How to choose</h2></div>
          <ol className="mt-3 space-y-2">{result.comparison.decision_guide.map((item, index) => <li key={index} className="flex gap-2 text-xs leading-relaxed text-foreground/75"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-[9px] font-black">{index + 1}</span>{item}</li>)}</ol>
        </section>
        <GraphTrace trace={result.trace} result={result} />
      </div>

      {result.comparison.caveats.length > 0 && <section className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-xs font-black text-amber-900">Evidence caveats</p><ul className="mt-2 space-y-1">{result.comparison.caveats.map((item) => <li key={item} className="text-[11px] leading-relaxed text-amber-800">· {item}</li>)}</ul></section>}
    </div>
  );
}

function GraphTrace({ trace, result }: { trace: RagGraphTraceEntry[]; result: RagInstructorCompareResponse }) {
  const retrieval = trace.filter((entry) => ["compare_vector", "compare_keyword", "compare_metadata"].includes(entry.node));
  const instructorBranches = trace.filter((entry) => entry.node.startsWith("compare_instructor:"));
  const beforeBranches = trace.filter((entry) => ["compare_fuse", "compare_retrieve", "compare_attribute", "compare_panel"].includes(entry.node));
  const afterBranches = trace.filter((entry) => ["compare_synthesize", "compare_validate"].includes(entry.node));
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2"><Workflow size={15} className="text-accent" /><h2 className="text-base font-bold">What LangGraph executed</h2></div>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Parallel rows visibly fan out, then join before the next checkpoint.</p>
      <TraceGroup label="Retrieval fan-out" entries={retrieval} result={result} />
      <div className="flex justify-center py-1 text-muted-foreground"><ChevronRight size={12} className="rotate-90" /></div>
      {beforeBranches.map((entry) => <TraceRow key={entry.node} entry={entry} technology={traceTechnology(entry.node, result)} />)}
      <TraceGroup label="Instructor fan-out" entries={instructorBranches} result={result} />
      <div className="flex justify-center py-1 text-muted-foreground"><ChevronRight size={12} className="rotate-90" /></div>
      {afterBranches.map((entry) => <TraceRow key={entry.node} entry={entry} technology={traceTechnology(entry.node, result)} />)}
    </section>
  );
}

function TraceGroup({ label, entries, result }: { label: string; entries: RagGraphTraceEntry[]; result: RagInstructorCompareResponse }) {
  return <div className="mt-3 rounded-lg border border-accent/20 bg-accent/5 p-2"><p className="mb-1.5 text-[9px] font-black uppercase tracking-wider text-accent">{label} · parallel</p><div className="grid gap-1 sm:grid-cols-3">{entries.map((entry) => <TraceRow key={entry.node} entry={entry} compact technology={traceTechnology(entry.node, result)} />)}</div></div>;
}

function TraceRow({ entry, compact = false, technology }: { entry: RagGraphTraceEntry; compact?: boolean; technology: string }) {
  const tooltipId = useId();
  return (
    <div tabIndex={0} aria-describedby={tooltipId} className={`group/trace relative flex items-center gap-2 rounded-lg border border-border bg-card outline-none focus:border-accent ${compact ? "px-2 py-1.5" : "my-1 px-2.5 py-2"}`}>
      <CheckCircle2 size={10} className="shrink-0 text-emerald-600" />
      <span className="min-w-0 flex-1 truncate text-[9px] font-bold">{entry.label}</span>
      <span className="shrink-0 text-[8px] text-muted-foreground">{entry.ms}ms</span>
      <span id={tooltipId} role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-72 -translate-x-1/2 rounded-lg bg-foreground p-3 text-left text-background shadow-xl group-hover/trace:block group-focus/trace:block">
        <strong className="block text-[11px]">{entry.label} · {entry.ms}ms</strong>
        <span className="mt-1 block font-mono text-[9px] opacity-70">{entry.node}</span>
        <span className="mt-1.5 block text-[10px] leading-relaxed">{entry.detail}</span>
        <span className="mt-1.5 block border-t border-background/20 pt-1.5 text-[9px] leading-relaxed opacity-80">Technology: {technology}</span>
      </span>
    </div>
  );
}

function traceTechnology(node: string, result: RagInstructorCompareResponse): string {
  if (node === "compare_keyword") return "Postgres full-text search; no language model";
  if (node === "compare_metadata") return "Supabase rag_techniques metadata query; no language model";
  if (node === "compare_vector") return result.models.semantic_embedding ? `OpenAI ${result.models.semantic_embedding} query embedding + pgvector similarity search` : "Disabled in Local Qwen zero-paid mode; no embedding model called";
  if (node === "compare_fuse") return "Deterministic Reciprocal Rank Fusion and per-video diversity; no language model";
  if (node === "compare_attribute") return "rag_videos → rag_video_attributions → canonical person in rag_creators; no language model";
  if (node === "compare_panel") return result.models.evidence_reranker
    ? `${result.models.evidence_reranker} relevance reranker + deterministic instructor diversity`
    : "Deterministic instructor diversity; reranker not invoked because the attributed pool was already within the limit";
  if (node.startsWith("compare_instructor:")) return `Independent ${result.model} analysis branch via ${result.provider}`;
  if (node === "compare_synthesize") return `${result.models.synthesis} cross-instructor synthesis via ${result.provider}`;
  if (node === "compare_validate") return "Deterministic source-ID and multi-instructor citation validation; no language model";
  return "LangGraph orchestration and Postgres checkpointing";
}

function RunHistory({ runs }: { runs: RagInstructorCompareResponse[] }) {
  return <section className="rounded-2xl border border-border bg-card p-5 shadow-sm"><h2 className="text-base font-bold">Latency and output comparison</h2><p className="mt-1 text-[10px] text-muted-foreground">Runs remain separate LangGraph threads. Compare speed, token volume, evidence coverage, and the grounded output above.</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-[10px]"><thead className="border-b border-border text-[9px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-2">Model</th><th>Time</th><th>Tokens</th><th>Panel</th><th>Evidence</th><th>Consensus</th><th>Differences</th></tr></thead><tbody>{runs.map((run) => <tr key={run.thread_id} className="border-b border-border/60 last:border-0"><td className="py-2 pr-3"><strong className="block">{run.model}</strong><span className="text-muted-foreground">{run.zero_paid_model_mode ? "local / free" : run.provider}</span></td><td>{(run.total_ms / 1000).toFixed(1)}s</td><td>{run.usage.total_tokens.toLocaleString()}</td><td>{run.instructor_count}</td><td>{run.evidence_count}</td><td>{run.comparison.shared_principles.length}</td><td>{run.comparison.important_differences.length}</td></tr>)}</tbody></table></div></section>;
}

function ClaimCard({ text, citations }: { text: string; citations: RagAnswerCitation[] }) {
  return <div className="rounded-xl border border-border bg-secondary/40 p-4"><p className="text-xs leading-relaxed text-foreground/80">{text}</p><CitationLinks citations={citations} /></div>;
}

function CitationLinks({ citations }: { citations: RagAnswerCitation[] }) {
  return <div className="mt-3 grid gap-1.5">{citations.map((item, index) => <a key={`${item.citation}-${index}`} href={item.watch_url ?? undefined} target={item.watch_url ? "_blank" : undefined} rel="noreferrer" className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-[10px] hover:border-foreground/30"><Play size={10} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate font-bold">{item.channel} · {item.title}</span><span className="shrink-0 text-muted-foreground">{seconds(item.start_seconds)}</span>{item.watch_url && <ExternalLink size={9} className="shrink-0" />}</a>)}</div>;
}

function DetailList({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return <div className="mt-3"><p className="text-[9px] font-black uppercase tracking-wider text-muted-foreground">{title}</p><ul className="mt-1 space-y-1">{items.map((item) => <li key={item} className={`flex gap-1.5 text-[10px] leading-relaxed ${muted ? "text-muted-foreground" : "text-foreground/70"}`}><span>·</span>{item}</li>)}</ul></div>;
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="rounded-xl border border-emerald-200 bg-card p-3 text-center"><strong className="block text-lg font-black">{value}</strong><span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span></div>;
}

function ModelStage({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-emerald-200 bg-card px-2.5 py-2"><span className="font-black text-emerald-800">{label}:</span> <span className="text-muted-foreground">{value}</span></div>;
}
