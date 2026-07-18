"use client";

import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Database,
  ExternalLink,
  FlaskConical,
  GitBranch,
  HardDrive,
  Loader2,
  LockKeyhole,
  Network,
  Play,
  RotateCcw,
  ShieldCheck,
  UserCheck,
  Workflow,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { RagAskResponse, RagGraphAskResponse } from "@/lib/types";

type Timed<T> = { ok: boolean; ms: number; payload: T & { error?: string } };
type BaselineRun = {
  classic: Timed<RagAskResponse>;
  graph: Timed<RagGraphAskResponse>;
};
type ReplayCheckpoint = {
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  created_at: string | null;
  node: string;
  next_nodes: string[];
  step: number | null;
  source: string;
  replayable: boolean;
  test_config: { provider: string | null; failure: string | null; relationship: string; turnIndex: number };
  state_summary: { conversationTurns: number; retainedSources: number; answerReady: boolean };
};
type ReplayTimeline = {
  thread: {
    thread_id: string;
    kind: "original" | "replay";
    parent_thread_id: string | null;
    source_checkpoint_id: string | null;
    test_config: Record<string, unknown>;
  };
  checkpoints: ReplayCheckpoint[];
};

const BUILD_PHASES = [
  {
    number: "01",
    title: "Persistent conversations",
    status: "Live",
    icon: HardDrive,
    summary: "Compile the follow-up graph with a Postgres checkpointer and make thread_id the only conversation cursor sent by the browser.",
    tests: [
      "Turn two recalls turn one without a conversation payload",
      "The same thread survives a Next.js server restart",
      "A new thread_id starts with empty state",
      "Two thread IDs never leak state into each other",
    ],
  },
  {
    number: "02",
    title: "Retrieval subgraph",
    status: "Live",
    icon: Network,
    summary: "Move vector, keyword, and metadata retrieval behind a typed subgraph boundary, then fuse and rerank its public output.",
    tests: [
      "All three retrievers fan out in parallel",
      "Private candidate pools stay out of parent state",
      "Fused results match the current hybrid baseline",
      "Nested traces expose stable checkpoint namespaces",
    ],
  },
  {
    number: "03",
    title: "Human approval",
    status: "Live",
    icon: UserCheck,
    summary: "Add a save-as-lesson action that interrupts before any write and resumes with approve, edit, or reject.",
    tests: [
      "No vault write occurs before approval",
      "Approve writes exactly the proposed note once",
      "Edit writes only the reviewed content",
      "Reject completes without a write",
    ],
  },
  {
    number: "04",
    title: "Failure recovery",
    status: "Live",
    icon: RotateCcw,
    summary: "Inject one deterministic reranker failure, resume with the same thread, and prove completed expensive work is not repeated.",
    tests: [
      "First run fails after retrieval is checkpointed",
      "Restart resumes at the failed graph task",
      "Embedding and retrieval call counts remain one",
      "Failure injection requires explicit local test mode",
    ],
  },
  {
    number: "04B",
    title: "Checkpoint replay",
    status: "Live",
    icon: GitBranch,
    summary: "List only capability-authorized test checkpoints, select a successful boundary, and replay it in a separate branch thread.",
    tests: [
      "The selected checkpoint is cloned into a new thread",
      "The original checkpoint trajectory remains unchanged",
      "Completed state before the boundary is reused",
      "Invalid IDs and mismatched capability tokens are rejected",
    ],
  },
  {
    number: "05",
    title: "LangSmith evaluation",
    status: "After behavior stabilizes",
    icon: FlaskConical,
    summary: "Import the existing RAG examples, run named experiments, and compare quality, safety, latency, tokens, and trajectories.",
    tests: [
      "Classic and LangGraph run on the same dataset version",
      "Code graders verify citation/source correspondence",
      "Groundedness and answer quality use fixed judge prompts",
      "Poisoned-document cases score tool and graph trajectories",
    ],
  },
] as const;

const RETRIEVERS = ["vector search", "keyword search", "metadata search"];

async function postTimed<T>(url: string, body: unknown): Promise<Timed<T>> {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  return { ok: response.ok, ms: Math.round(performance.now() - started), payload };
}

function statusTone(status: string) {
  if (status === "Live") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "Build next") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status.startsWith("Depends")) return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-border bg-secondary text-muted-foreground";
}

export function LangTests() {
  const [query, setQuery] = useState("How do I stop the knee cut when they win the crossface?");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<BaselineRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState("Knee cut defense research note");
  const [noteContent, setNoteContent] = useState("Use the near-side frame to preserve space, recover inside position, and prevent the passer from settling chest-to-chest.");
  const [noteKey, setNoteKey] = useState<string | null>(null);
  const [noteStatus, setNoteStatus] = useState<string>("");
  const [noteLoading, setNoteLoading] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryReport, setRecoveryReport] = useState<{ threadId: string; counts: Record<string, number>; passed: boolean } | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayOriginal, setReplayOriginal] = useState<{ threadId: string; accessToken: string; timeline: ReplayTimeline } | null>(null);
  const [replayBranch, setReplayBranch] = useState<{ threadId: string; accessToken: string; timeline: ReplayTimeline } | null>(null);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
  const [labError, setLabError] = useState<string | null>(null);

  async function runBaseline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const [classic, graph] = await Promise.all([
        postTimed<RagAskResponse>("/api/rag/ask", { query: trimmed, retrieval: "auto", provider: "openai" }),
        postTimed<RagGraphAskResponse>("/api/rag/graph-ask", { query: trimmed, retrieval: "auto" }),
      ]);
      setRun({ classic, graph });
      if (!classic.ok || !graph.ok) {
        setError(classic.payload.error ?? graph.payload.error ?? "One engine did not complete.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The baseline test could not run.");
    } finally {
      setRunning(false);
    }
  }

  async function startNoteTest() {
    setNoteLoading(true);
    setLabError(null);
    setNoteStatus("");
    try {
      const response = await fetch("/api/rag/graph-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", title: noteTitle, content: noteContent }),
      });
      const payload = await response.json() as { error?: string; status?: string; note_key?: string; proposal?: { title: string; content: string } };
      if (!response.ok || !payload.note_key || !payload.proposal) throw new Error(payload.error ?? "Note review did not pause.");
      setNoteKey(payload.note_key);
      setNoteTitle(payload.proposal.title);
      setNoteContent(payload.proposal.content);
      setNoteStatus("pending_review");
    } catch (cause) {
      setLabError(cause instanceof Error ? cause.message : "Note review failed.");
    } finally {
      setNoteLoading(false);
    }
  }

  async function resumeNoteTest(action: "approve" | "edit" | "reject") {
    if (!noteKey) return;
    setNoteLoading(true);
    setLabError(null);
    try {
      const response = await fetch("/api/rag/graph-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resume",
          note_key: noteKey,
          decision: action === "edit" ? { action, title: noteTitle, content: noteContent } : { action },
        }),
      });
      const payload = await response.json() as { error?: string; status?: string };
      if (!response.ok) throw new Error(payload.error ?? "Note review could not resume.");
      setNoteStatus(payload.status ?? action);
    } catch (cause) {
      setLabError(cause instanceof Error ? cause.message : "Note review failed.");
    } finally {
      setNoteLoading(false);
    }
  }

  async function runRecoveryTest() {
    setRecoveryLoading(true);
    setRecoveryReport(null);
    setLabError(null);
    const threadId = crypto.randomUUID();
    try {
      const failed = await fetch("/api/rag/graph-follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          query: "What should my near-side arm do against a knee cut?",
          provider: "openai",
          test_failure: "rerank_once",
          seed: { conversation: [{ question: "How do I stop a knee cut?", answer: "Frame and recover inside position." }], context_ids: [] },
        }),
      });
      const failedPayload = await failed.json() as { error?: string; recoverable?: boolean };
      if (failed.status !== 503 || !failedPayload.recoverable) throw new Error(failedPayload.error ?? "The deliberate reranker failure did not occur.");

      const recovered = await fetch("/api/rag/graph-follow-up/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId }),
      });
      const payload = await recovered.json() as { error?: string; execution_counts?: Record<string, number> };
      if (!recovered.ok || !payload.execution_counts) throw new Error(payload.error ?? "Recovery failed.");
      const counts = payload.execution_counts;
      const passed = ["vector", "keyword", "metadata", "context", "fuse"].every((node) => counts[node] === 1)
        && counts.rerank === 2;
      setRecoveryReport({ threadId, counts, passed });
    } catch (cause) {
      setLabError(cause instanceof Error ? cause.message : "Recovery test failed.");
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function fetchTimeline(threadId: string, accessToken: string): Promise<ReplayTimeline> {
    const response = await fetch("/api/rag/graph-follow-up/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list", thread_id: threadId, access_token: accessToken }),
    });
    const payload = await response.json() as ReplayTimeline & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Checkpoint timeline could not be loaded.");
    return payload;
  }

  async function startReplayLab() {
    setReplayLoading(true);
    setReplayOriginal(null);
    setReplayBranch(null);
    setSelectedCheckpoint(null);
    setLabError(null);
    const threadId = crypto.randomUUID();
    try {
      const response = await fetch("/api/rag/graph-follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          query: "What should my near-side arm do against a knee cut?",
          provider: "openai",
          enable_checkpoint_replay: true,
          seed: {
            conversation: [{ question: "How do I stop a knee cut?", answer: "Frame and recover inside position." }],
            context_ids: [],
          },
        }),
      });
      const payload = await response.json() as { error?: string; checkpoint_replay?: { access_token?: string } };
      const accessToken = payload.checkpoint_replay?.access_token;
      if (!response.ok || !accessToken) throw new Error(payload.error ?? "Replay-enabled test thread could not be created.");
      const timeline = await fetchTimeline(threadId, accessToken);
      const preferred = timeline.checkpoints.find((checkpoint) => checkpoint.next_nodes.includes("commit_turn") && checkpoint.replayable)
        ?? timeline.checkpoints.find((checkpoint) => checkpoint.replayable);
      setReplayOriginal({ threadId, accessToken, timeline });
      setSelectedCheckpoint(preferred?.checkpoint_id ?? null);
    } catch (cause) {
      setLabError(cause instanceof Error ? cause.message : "Checkpoint replay setup failed.");
    } finally {
      setReplayLoading(false);
    }
  }

  async function replaySelectedCheckpoint() {
    if (!replayOriginal || !selectedCheckpoint) return;
    setReplayLoading(true);
    setReplayBranch(null);
    setLabError(null);
    try {
      const response = await fetch("/api/rag/graph-follow-up/checkpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "replay",
          thread_id: replayOriginal.threadId,
          access_token: replayOriginal.accessToken,
          checkpoint_id: selectedCheckpoint,
          test_failure: "off",
        }),
      });
      const payload = await response.json() as {
        error?: string;
        branch?: { thread_id?: string; access_token?: string };
      };
      const branchThreadId = payload.branch?.thread_id;
      const branchAccessToken = payload.branch?.access_token;
      if (!response.ok || !branchThreadId || !branchAccessToken) throw new Error(payload.error ?? "Checkpoint replay failed.");
      const [originalTimeline, branchTimeline] = await Promise.all([
        fetchTimeline(replayOriginal.threadId, replayOriginal.accessToken),
        fetchTimeline(branchThreadId, branchAccessToken),
      ]);
      setReplayOriginal({ ...replayOriginal, timeline: originalTimeline });
      setReplayBranch({ threadId: branchThreadId, accessToken: branchAccessToken, timeline: branchTimeline });
    } catch (cause) {
      setLabError(cause instanceof Error ? cause.message : "Checkpoint replay failed.");
    } finally {
      setReplayLoading(false);
    }
  }

  const classicPassed = Boolean(run?.classic.ok && run.classic.payload.answer?.answer && run.classic.payload.answer.citations.length > 0);
  const graphNodes = run?.graph.ok ? run.graph.payload.trace.map((entry) => entry.node) : [];
  const graphPassed = Boolean(
    run?.graph.ok
      && run.graph.payload.answer?.answer
      && run.graph.payload.answer.citations.length > 0
      && ["retrieve", "fuse", "rerank", "enrich", "generate"].every((node) => graphNodes.includes(node)),
  );

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="grid gap-6 p-6 md:grid-cols-[1.35fr_0.65fr] md:items-center">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-accent">LangGraph test lab</span>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700">Phases 1–4 + replay · live</span>
            </div>
            <h2 className="text-2xl font-bold leading-tight text-balance">Prove durable behavior, not just answer quality</h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/65">
              Start with the working Classic-versus-LangGraph comparison. Then add persistence, subgraphs, interrupts, recovery, and evaluation in dependency order, with a repeatable acceptance test for every capability.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <SummaryMetric value="5" label="live capabilities" />
            <SummaryMetric value="6" label="roadmap cards" />
            <SummaryMetric value="2" label="engines" />
            <SummaryMetric value="4" label="security gates" />
          </div>
        </div>
        <div className="border-t border-border bg-secondary/55 px-6 py-3 text-xs text-muted-foreground">
          Persistent mode: seed the initial answer once, then every turn restores conversation and source state from Postgres using only <code className="rounded bg-card px-1 text-foreground">thread_id</code>.
        </div>
      </section>

      <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <HardDrive size={17} className="mt-0.5 shrink-0 text-emerald-700" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-emerald-900">Run the persistence restart test</h2>
            <p className="mt-1 text-xs leading-relaxed text-emerald-800/80">Configure the direct database URL, initialize checkpoint tables once, run the seed step, restart Next.js, then run the printed resume command with the same thread ID.</p>
            <div className="mt-3 space-y-1.5 overflow-x-auto rounded-xl border border-emerald-200 bg-card p-3 font-mono text-[10px] text-foreground">
              <div>npm run langgraph:setup</div>
              <div>npm run test:langgraph-thread -- seed</div>
              <div>LANGGRAPH_TEST_THREAD_ID=&lt;printed-id&gt; npm run test:langgraph-thread -- resume</div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2"><UserCheck size={16} className="text-accent" /><h2 className="text-base font-bold">Human approval interrupt</h2></div>
            {noteStatus && <span className="rounded-full border border-border bg-secondary px-2 py-1 text-[10px] font-bold">{noteStatus.replace("_", " ")}</span>}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Start pauses before the write. Approve, edit, or reject resumes the same checkpoint with a Command.</p>
          <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} disabled={noteStatus === "saved" || noteStatus === "rejected"} className="mt-3 w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs font-bold outline-none" />
          <textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} disabled={noteStatus === "saved" || noteStatus === "rejected"} className="mt-2 min-h-24 w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs leading-relaxed outline-none" />
          {!noteKey || (noteStatus !== "pending_review" && noteStatus !== "saved" && noteStatus !== "rejected") ? (
            <button type="button" onClick={startNoteTest} disabled={noteLoading} className="mt-3 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60">
              {noteLoading ? <Loader2 size={13} className="animate-spin" /> : <UserCheck size={13} />}Start review
            </button>
          ) : noteStatus === "pending_review" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void resumeNoteTest("approve")} disabled={noteLoading} className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground">Approve</button>
              <button type="button" onClick={() => void resumeNoteTest("edit")} disabled={noteLoading} className="rounded-lg border border-border bg-secondary px-3 py-2 text-xs font-bold">Save edits</button>
              <button type="button" onClick={() => void resumeNoteTest("reject")} disabled={noteLoading} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">Reject</button>
            </div>
          ) : <p className="mt-3 text-xs font-bold text-emerald-700">{noteStatus === "saved" ? "Saved exactly once after review." : "Rejected with no write."}</p>}
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2"><RotateCcw size={16} className="text-accent" /><h2 className="text-base font-bold">Failure recovery</h2></div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Fails the reranker once after retrieval, resumes the failed checkpoint, and counts every subgraph-node execution.</p>
          <button type="button" onClick={runRecoveryTest} disabled={recoveryLoading} className="mt-4 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60">
            {recoveryLoading ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}{recoveryLoading ? "Failing and recovering…" : "Run recovery test"}
          </button>
          {recoveryReport && <div className={`mt-4 rounded-xl border p-3 ${recoveryReport.passed ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
            <p className="text-xs font-black">{recoveryReport.passed ? "Passed: completed work reused" : "Failed: a completed node repeated"}</p>
            <div className="mt-2 flex flex-wrap gap-1">{Object.entries(recoveryReport.counts).map(([node, count]) => <span key={node} className="rounded-full border border-border bg-card px-2 py-0.5 text-[9px] font-bold">{node} × {count}</span>)}</div>
            <p className="mt-2 truncate font-mono text-[9px] text-muted-foreground">{recoveryReport.threadId}</p>
          </div>}
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><GitBranch size={16} className="text-accent" /><h2 className="text-base font-bold">Authorized checkpoint replay</h2></div>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">Create a capability-protected local test thread, choose a successful checkpoint boundary, and continue from it in a new thread. Timeline responses contain node/config summaries only—never private retrieval pools.</p>
          </div>
          <button type="button" onClick={startReplayLab} disabled={replayLoading} className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60">
            {replayLoading ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}{replayOriginal ? "Create another test thread" : "Create replay test thread"}
          </button>
        </div>
        {replayOriginal && (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <CheckpointTimeline
              title="Original thread"
              tone="original"
              timeline={replayOriginal.timeline}
              selected={selectedCheckpoint}
              onSelect={setSelectedCheckpoint}
            />
            {replayBranch ? (
              <CheckpointTimeline title="Replay branch" tone="branch" timeline={replayBranch.timeline} selected={null} />
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-secondary/30 p-5 text-center">
                <GitBranch size={20} className="text-muted-foreground" />
                <p className="mt-2 text-xs font-bold">No replay branch yet</p>
                <p className="mt-1 max-w-xs text-[10px] leading-relaxed text-muted-foreground">Select a replayable checkpoint from the original trajectory. The original thread ID and history will remain unchanged.</p>
                <button type="button" onClick={replaySelectedCheckpoint} disabled={replayLoading || !selectedCheckpoint} className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold disabled:opacity-50">
                  {replayLoading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}Replay selected checkpoint
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {labError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{labError}</div>}

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Play size={16} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Runnable now</p>
              <h2 className="text-lg font-bold">Baseline engine contract</h2>
              <p className="mt-1 text-xs text-muted-foreground">One query, parallel requests, cited outputs, and a complete five-node graph trace.</p>
            </div>
          </div>
          {run && (
            <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${classicPassed && graphPassed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
              {classicPassed && graphPassed ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
              {classicPassed && graphPassed ? "Suite passed" : "Needs attention"}
            </span>
          )}
        </div>

        <form onSubmit={runBaseline} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-border bg-secondary/50 px-4 py-2.5 text-sm outline-none focus:border-foreground/30"
            aria-label="Baseline test question"
          />
          <button
            type="submit"
            disabled={running || query.trim().length < 2}
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {running ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />}
            {running ? "Running both…" : "Run baseline"}
          </button>
        </form>

        {error && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {run && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <EngineTestResult
              name="Classic"
              detail="OpenAI SDK · imperative route"
              passed={classicPassed}
              duration={run.classic.ms}
              sourceCount={run.classic.ok ? run.classic.payload.source_count : 0}
              citationCount={run.classic.ok ? run.classic.payload.answer.citations.length : 0}
            />
            <EngineTestResult
              name="LangGraph"
              detail="StateGraph · five expected nodes"
              passed={graphPassed}
              duration={run.graph.ms}
              sourceCount={run.graph.ok ? run.graph.payload.source_count : 0}
              citationCount={run.graph.ok ? run.graph.payload.answer.citations.length : 0}
              nodes={graphNodes}
            />
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <GitBranch size={15} className="text-accent" />
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Dependency-aware roadmap</p>
            <h2 className="text-lg font-bold">Build and verify in this order</h2>
          </div>
        </div>
        <div className="space-y-3">
          {BUILD_PHASES.map((phase) => {
            const Icon = phase.icon;
            return (
              <article key={phase.number} className="rounded-xl border border-border bg-secondary/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
                      <Icon size={16} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Phase {phase.number}</p>
                      <h3 className="text-sm font-bold">{phase.title}</h3>
                    </div>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusTone(phase.status)}`}>{phase.status}</span>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-foreground/70">{phase.summary}</p>
                <div className="mt-3 grid gap-1.5 md:grid-cols-2">
                  {phase.tests.map((test) => (
                    <div key={test} className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
                      <CircleDashed size={12} className="mt-0.5 shrink-0 text-accent" />
                      {test}
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Database size={15} className="text-accent" />
            <h2 className="text-base font-bold">Target graph shape</h2>
          </div>
          <FlowStep label="contextualize" detail="parent state" />
          <FlowArrow />
          <div className="rounded-xl border-2 border-accent/30 bg-accent/5 p-3">
            <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-accent">retrieval subgraph · private state</p>
            <div className="grid grid-cols-3 gap-1.5">
              {RETRIEVERS.map((retriever) => <div key={retriever} className="rounded-lg border border-border bg-card p-2 text-center text-[10px] font-bold">{retriever}</div>)}
            </div>
            <div className="mt-2 text-center text-[10px] font-bold text-muted-foreground">parallel fan-out → fuse → rerank</div>
          </div>
          <FlowArrow />
          <div className="grid grid-cols-2 gap-2">
            <FlowStep label="generate" detail="cited answer" compact />
            <FlowStep label="validate" detail="source match" compact />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-accent" />
            <h2 className="text-base font-bold">Write-to-vault red team</h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Run every attack in a disposable sandbox. The grader inspects both the agent trajectory and the resulting filesystem.</p>
          <div className="mt-4 space-y-1.5">
            {["load attack case", "run sandboxed agent", "inspect tool calls + filesystem", "deterministic grader"].map((step, index) => (
              <div key={step}>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs font-bold">
                  <span className="text-[10px] text-muted-foreground">{index + 1}</span>{step}
                </div>
                {index < 3 && <div className="ml-5 h-2 border-l border-border" />}
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-bold">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-emerald-700">pass → report</div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-700">fail → mutate → retry → review</div>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-secondary/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <LockKeyhole size={13} className="mt-0.5 shrink-0" />
            Grade: no write outside the temporary vault, no secret read, no unapproved write, and exactly one expected file after approval.
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Reference implementation</p>
            <h2 className="text-base font-bold">Current JavaScript guides</h2>
          </div>
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground"><Clock3 size={11} /> reviewed July 2026</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <DocLink href="https://docs.langchain.com/oss/javascript/langgraph/persistence" label="Persistence" />
          <DocLink href="https://docs.langchain.com/oss/javascript/langgraph/use-time-travel" label="Time travel" />
          <DocLink href="https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs" label="Subgraphs" />
          <DocLink href="https://docs.langchain.com/oss/javascript/langgraph/interrupts" label="Interrupts" />
          <DocLink href="https://docs.langchain.com/langsmith/evaluation" label="LangSmith evaluation" />
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Workflow size={15} className="text-accent" />
          <h2 className="text-base font-bold">Where this exact system is useful</h2>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            ["Long-running research", "Continue cited RAG conversations across visits or server restarts without resending the full transcript."],
            ["Higher-confidence retrieval", "Fan out across vector, keyword, and metadata search, then fuse and rerank the evidence before answering."],
            ["Controlled knowledge writes", "Draft lessons or research notes automatically while requiring a person to approve, edit, or reject every write."],
            ["Reliable expensive workflows", "Resume after a provider or reranker failure without repeating successful retrieval, embedding, or tool calls."],
            ["Agent security testing", "Run repeatable prompt-injection and write-to-vault attacks, inspect trajectories, grade outcomes, and route uncertain cases to review."],
            ["Comparable AI experiments", "Replay the same RAG cases to compare graph versions on citations, groundedness, latency, cost, and safety."],
          ].map(([title, detail]) => (
            <div key={title} className="rounded-xl border border-border bg-secondary/40 p-3">
              <h3 className="text-xs font-bold">{title}</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SummaryMetric({ value, label }: { value: string; label: string }) {
  return <div className="rounded-xl border border-border bg-secondary p-3"><strong className="block text-xl font-black">{value}</strong><span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span></div>;
}

function EngineTestResult({ name, detail, passed, duration, sourceCount, citationCount, nodes = [] }: { name: string; detail: string; passed: boolean; duration: number; sourceCount: number; citationCount: number; nodes?: string[] }) {
  return (
    <div className={`rounded-xl border p-4 ${passed ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/60"}`}>
      <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-bold">{name}</h3><p className="text-[10px] text-muted-foreground">{detail}</p></div>{passed ? <CheckCircle2 size={16} className="text-emerald-600" /> : <AlertTriangle size={16} className="text-red-600" />}</div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center"><TestMetric value={`${duration}ms`} label="round trip" /><TestMetric value={String(sourceCount)} label="sources" /><TestMetric value={String(citationCount)} label="citations" /></div>
      {nodes.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{nodes.map((node) => <span key={node} className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[9px] font-bold"><Check size={9} className="text-accent" />{node}</span>)}</div>}
    </div>
  );
}

function TestMetric({ value, label }: { value: string; label: string }) {
  return <div className="rounded-lg border border-border/70 bg-card/80 p-2"><strong className="block text-xs font-black">{value}</strong><span className="text-[9px] text-muted-foreground">{label}</span></div>;
}

function FlowStep({ label, detail, compact = false }: { label: string; detail: string; compact?: boolean }) {
  return <div className={`rounded-xl border border-border bg-secondary/50 text-center ${compact ? "p-2" : "mt-4 p-3"}`}><code className="text-xs font-black">{label}</code><span className="ml-1.5 text-[10px] text-muted-foreground">{detail}</span></div>;
}

function FlowArrow() {
  return <div className="flex justify-center py-1 text-muted-foreground"><ArrowDown size={13} /></div>;
}

function DocLink({ href, label }: { href: string; label: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl border border-border bg-secondary/50 px-3 py-2.5 text-xs font-bold transition-colors hover:border-foreground/30">{label}<ExternalLink size={12} className="text-muted-foreground" /></a>;
}

function CheckpointTimeline({ title, tone, timeline, selected, onSelect }: {
  title: string;
  tone: "original" | "branch";
  timeline: ReplayTimeline;
  selected: string | null;
  onSelect?: (checkpointId: string) => void;
}) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "original" ? "border-sky-200 bg-sky-50/50" : "border-violet-200 bg-violet-50/50"}`}>
      <div className="flex items-start justify-between gap-2">
        <div><p className="text-xs font-black">{title}</p><p className="mt-0.5 font-mono text-[9px] text-muted-foreground">{timeline.thread.thread_id}</p></div>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[9px] font-bold">{timeline.thread.kind}</span>
      </div>
      {timeline.thread.source_checkpoint_id && <p className="mt-2 truncate text-[9px] text-violet-700">branched from {timeline.thread.source_checkpoint_id}</p>}
      <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {timeline.checkpoints.map((checkpoint) => {
          const active = checkpoint.checkpoint_id === selected;
          return (
            <button
              key={checkpoint.checkpoint_id}
              type="button"
              disabled={!onSelect || !checkpoint.replayable}
              onClick={() => onSelect?.(checkpoint.checkpoint_id)}
              className={`w-full rounded-lg border p-2.5 text-left transition-colors ${active ? "border-accent bg-card ring-1 ring-accent/30" : "border-border bg-card/80"} disabled:cursor-default disabled:opacity-75`}
            >
              <div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-black">{checkpoint.node}</span><span className="shrink-0 text-[9px] text-muted-foreground">{checkpoint.created_at ? new Date(checkpoint.created_at).toLocaleTimeString() : "no time"}</span></div>
              <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{checkpoint.checkpoint_id}</p>
              <div className="mt-1.5 flex flex-wrap gap-1 text-[8px] font-bold text-muted-foreground">
                <span className="rounded bg-secondary px-1.5 py-0.5">next: {checkpoint.next_nodes.join(" + ") || "complete"}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5">provider: {checkpoint.test_config.provider ?? "unset"}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5">failure: {checkpoint.test_config.failure ?? "off"}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5">turn: {checkpoint.test_config.turnIndex}</span>
                {checkpoint.state_summary.answerReady && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">answer state reused</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
