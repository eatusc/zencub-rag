"use client";

import { useEffect, useState } from "react";
import { BarChart3, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";

type Node = { name: string; type: string; depth: number; durMs: number | null; tokens: number | null };
type Trace = {
  id: string;
  timestamp: string;
  latencyMs: number | null;
  cost: number | null;
  spanCount: number;
  query: string;
  provider: string;
  answerPreview: string;
  nodes: Node[];
};
type ApiResult = {
  configured: boolean;
  error?: string;
  baseUrl?: string;
  projectId?: string;
  traces: Trace[];
};

function providerTone(p: string): string {
  if (p === "openrouter") return "bg-blue-500/10 text-blue-500 border-blue-500/20";
  if (p === "openai") return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
  if (p === "qwen") return "bg-amber-500/10 text-amber-500 border-amber-500/20";
  return "bg-muted text-muted-foreground border-border";
}

function fmtSecs(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function LangfuseTab() {
  const [data, setData] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch("/api/langfuse/traces")
      .then((r) => r.json())
      .then((d: ApiResult) => setData(d))
      .catch((e) => setData({ configured: false, error: String(e), traces: [] }))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
              <BarChart3 size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Langfuse — LLM Tracing</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Self-hosted Langfuse (on this Mac Studio) traces every RAG query and instructor-compare run — the full
                LangGraph node tree, latency, and cost. Below are the most recent runs captured live.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {loading && !data && <p className="px-1 text-sm text-muted-foreground">Loading traces…</p>}

      {data && !data.configured && (
        <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
          Langfuse isn&apos;t configured on this server (missing <code className="text-foreground">LANGFUSE_*</code> env).
        </div>
      )}

      {data && data.configured && data.error && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-600">
          Couldn&apos;t read Langfuse: {data.error}
        </div>
      )}

      {data && data.configured && !data.error && data.traces.length === 0 && (
        <p className="px-1 text-sm text-muted-foreground">No traces yet — run a search or an instructor comparison.</p>
      )}

      {/* Trace list */}
      <div className="space-y-3">
        {data?.traces.map((t) => {
          const isOpen = open === t.id;
          return (
            <div key={t.id} className="rounded-2xl border border-border bg-card overflow-hidden">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : t.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
              >
                <ChevronRight size={16} className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{t.query || "(query not captured)"}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t.timestamp ? new Date(t.timestamp).toLocaleString() : ""}
                  </p>
                </div>
                {t.provider && (
                  <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium ${providerTone(t.provider)}`}>
                    {t.provider}
                  </span>
                )}
                <div className="hidden shrink-0 gap-4 text-right text-[11px] text-muted-foreground sm:flex">
                  <span title="latency">{fmtSecs(t.latencyMs)}</span>
                  <span title="observations">{t.spanCount} spans</span>
                  <span title="cost">${(t.cost ?? 0).toFixed(4)}</span>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-border px-4 py-3">
                  {t.answerPreview && (
                    <div className="mb-3 rounded-lg bg-muted/40 p-3 text-[13px] leading-relaxed text-foreground">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Answer</span>
                      <p className="mt-1">{t.answerPreview}{t.answerPreview.length >= 280 ? "…" : ""}</p>
                    </div>
                  )}
                  <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Trace tree · {t.nodes.length} observations
                  </p>
                  <div className="space-y-0.5 font-mono text-[11px]">
                    {t.nodes.map((n, i) => (
                      <div key={i} className="flex items-center gap-2 text-muted-foreground" style={{ paddingLeft: `${n.depth * 14}px` }}>
                        <span className="text-foreground/80">└ {n.name}</span>
                        <span className="rounded bg-muted px-1 text-[9px]">{n.type}</span>
                        <span>{fmtSecs(n.durMs)}</span>
                        {n.tokens != null && <span className="text-primary">tok={n.tokens}</span>}
                      </div>
                    ))}
                  </div>
                  {data.baseUrl && (
                    <a
                      href={`${data.baseUrl}/project/${data.projectId ?? "zencub-rag"}/traces/${t.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      Open in Langfuse <ExternalLink size={11} />
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
