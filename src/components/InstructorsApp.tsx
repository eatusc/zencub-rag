"use client";

// instructors.zencub.com: one question, one button, one comparison.
//
// The workflow behind it is the same checkpointed LangGraph the demo runs, but
// the request shape is different. A comparison takes about a minute, so the
// POST returns a thread id and this polls for the trace as nodes finish. That
// poll is also the interesting part of the interface: the reader watches
// retrieval fan out, an analysis branch open per instructor, those branches
// converge into one synthesis, and each claim get checked on its own.

import {
  ArrowRight,
  Check,
  Link2,
  Loader2,
  Scale,
  Split,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ZenCubFooter, ZenCubHeader } from "@/components/ZenCubChrome";
import type {
  RagAnswerCitation,
  RagGraphTraceEntry,
  RagInstructorAnalysis,
  RagStoredInstructorCompareRun,
} from "@/lib/types";

type Phase = "idle" | "running" | "done" | "error";
type Turn = { question: string; run: RagStoredInstructorCompareRun };
type RecentCard = {
  id: string;
  created_at: string;
  query: string;
  topic: string;
  instructors: string[];
  shared_principle_count: number;
  difference_count: number;
};

const EXAMPLES = [
  "breaking closed guard posture",
  "escaping side control",
  "the first grip in a triangle",
  "passing the knee shield",
];

const POLL_MS = 1_200;
// A run is about a minute. Five is well past anything healthy, and stopping is
// better than a spinner that never resolves.
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_TURNS = 4;

// Every stage of the graph, in the order the nodes report. Node ids come from
// the trace, so this is the real execution, not a scripted animation.
const STAGES: Array<{ key: string; label: string; detail: string; match: (node: string) => boolean }> = [
  {
    key: "retrieve",
    label: "Pulling tape",
    detail: "Keyword, meaning, and technique search run at once",
    match: (node) => node.startsWith("compare_initialize")
      || node.startsWith("compare_vector")
      || node.startsWith("compare_keyword")
      || node.startsWith("compare_metadata")
      || node.startsWith("compare_fuse")
      || node.startsWith("compare_retrieve"),
  },
  {
    key: "attribute",
    label: "Naming who is teaching",
    detail: "Clips only count when the instructor is known",
    match: (node) => node.startsWith("compare_attribute"),
  },
  {
    key: "panel",
    label: "Setting the panel",
    detail: "Best-supported instructors, capped per video",
    match: (node) => node.startsWith("compare_panel") || node.startsWith("compare_targeted_retrieval"),
  },
  {
    key: "analyze",
    label: "Studying each instructor",
    detail: "One branch each, none of them sees the others",
    match: (node) => node.startsWith("compare_instructor:"),
  },
  {
    key: "synthesize",
    label: "Bringing it together",
    detail: "The branches converge into one reading",
    match: (node) => node.startsWith("compare_synthesize"),
  },
  {
    key: "verify",
    label: "Checking every claim",
    detail: "Each claim is re-checked against the clips on its own",
    match: (node) => node.startsWith("compare_verify") || node.startsWith("compare_validate") || node.startsWith("compare_quality_gate"),
  },
];

function secondsLabel(value: number | string | null | undefined) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric ?? NaN)) return "0:00";
  const total = Math.max(0, Math.floor(numeric as number));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

export function InstructorsApp({ initialRunId }: { initialRunId?: string }) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [trace, setTrace] = useState<RagGraphTraceEntry[]>([]);
  const [thread, setThread] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{ threadId: string; token: string } | null>(null);
  const [recent, setRecent] = useState<RecentCard[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState("");

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  // Landing page only: a permalink has its own content and should not be
  // pushed down by a list of other people's comparisons.
  useEffect(() => {
    if (initialRunId) return;
    let cancelled = false;
    fetch("/api/instructors/runs")
      .then((response) => (response.ok ? response.json() : { runs: [] }))
      .then((body: { runs?: RecentCard[] }) => { if (!cancelled) setRecent(body.runs ?? []); })
      .catch(() => { /* the strip is optional furniture */ });
    return () => { cancelled = true; };
  }, [initialRunId]);

  // Permalink: /c/<id> loads a stored comparison instead of running one.
  useEffect(() => {
    if (!initialRunId) return;
    setPhase("running");
    fetch(`/api/instructors/runs?id=${encodeURIComponent(initialRunId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("That comparison could not be found.");
        return response.json() as Promise<{ run: RagStoredInstructorCompareRun }>;
      })
      .then((body) => {
        setThread([{ question: body.run.query, run: body.run }]);
        setPhase("done");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That comparison could not be found.");
        setPhase("error");
      });
  }, [initialRunId]);

  const poll = useCallback((threadId: string, startedAt: number) => {
    pollTimer.current = setTimeout(async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setError("That took longer than expected. Please try again.");
        setPhase("error");
        return;
      }
      try {
        const response = await fetch(`/api/instructors/compare?thread_id=${threadId}`);
        const body = (await response.json()) as {
          status?: string;
          trace?: RagGraphTraceEntry[];
          result?: RagStoredInstructorCompareRun;
          error?: string;
        };
        if (!response.ok) {
          setError(body.error ?? "That comparison is no longer running.");
          setPhase("error");
          return;
        }
        if (body.trace) setTrace(body.trace);
        if (body.status === "complete" && body.result) {
          setThread((previous) => [...previous, { question: body.result!.query, run: body.result! }]);
          setPendingQuestion("");
          setPhase("done");
          return;
        }
        if (body.status === "error") {
          setError(body.error ?? "The comparison failed.");
          setPhase("error");
          return;
        }
        poll(threadId, startedAt);
      } catch {
        setError("Lost contact with the server. Please try again.");
        setPhase("error");
      }
    }, POLL_MS);
  }, []);

  const start = useCallback(async (rawQuery: string, followUp: boolean) => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < 3) return;

    stopPolling();
    setError(null);
    setTrace([]);
    setPendingQuestion(trimmed);
    setPhase("running");
    if (!followUp) {
      setThread([]);
      setSession(null);
      window.history.replaceState(null, "", "/");
    }

    try {
      const response = await fetch("/api/instructors/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          ...(followUp && session ? { thread_id: session.threadId, session_token: session.token } : {}),
        }),
      });
      const body = (await response.json()) as { thread_id?: string; session_token?: string; error?: string };
      if (!response.ok || !body.thread_id || !body.session_token) {
        setError(body.error ?? "Could not start the comparison.");
        setPhase("error");
        return;
      }
      setSession({ threadId: body.thread_id, token: body.session_token });
      poll(body.thread_id, Date.now());
    } catch {
      setError("Could not reach the server. Please try again.");
      setPhase("error");
    }
  }, [poll, session, stopPolling]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void start(query, false);
  };

  const running = phase === "running";
  const hasOutput = thread.length > 0 || running || phase === "error";
  const latest = thread.at(-1);

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="pointer-events-none absolute top-0 left-0 right-0 h-[420px] bg-[radial-gradient(ellipse_at_50%_0%,rgba(196,168,130,0.06)_0%,transparent_70%)]" />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col px-5 sm:px-7">
        <ZenCubHeader />

        <main className="flex-1">
          <section className={hasOutput ? "text-center pt-10 pb-8" : "text-center pt-16 sm:pt-24 pb-10"}>
            <p className="text-[11px] tracking-[0.18em] text-zc-gold uppercase m-0">The Panel</p>
            <h1 className="text-[28px] sm:text-[46px] font-semibold leading-[1.1] tracking-tight mt-4 mx-auto max-w-[760px] text-balance text-zc-text-primary">
              Three instructors on one position.{" "}
              <span className="text-zc-gold font-medium">Where they agree, where they split.</span>
            </h1>
            {!hasOutput && (
              <p className="text-[15px] sm:text-[17px] text-zc-text-secondary leading-relaxed mt-5 mx-auto max-w-[620px]">
                Name a position or a problem. We pull what different instructors
                actually said about it, study each one separately, then show the
                overlap and the disagreements, cited to the second.
              </p>
            )}
          </section>

          <form onSubmit={submit} className="mx-auto max-w-[820px]">
            <div className="flex items-center gap-2.5 rounded-xl bg-zc-surface border border-zc-border px-4 py-3 focus-within:border-[rgba(196,168,130,0.4)]">
              <Users size={17} className="text-zc-text-dim shrink-0" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="A position, a problem, a technique…"
                aria-label="Position or technique to compare"
                maxLength={300}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-[15px] text-zc-text-primary"
              />
              <button
                type="submit"
                disabled={running || query.trim().length < 3}
                className="shrink-0 flex items-center gap-2 rounded-full bg-zc-gold px-4 py-1.5 text-[13px] font-semibold text-[#1a1917] disabled:opacity-40 hover:opacity-90"
              >
                {running && <Loader2 size={13} className="animate-spin" />}
                {running ? "Comparing…" : "Compare"}
              </button>
            </div>
            <p className="mt-3 text-center text-[12px] text-zc-text-dim">
              A comparison runs about a minute. Every claim is checked against the clips before you see it.
            </p>
          </form>

          {!hasOutput && (
            <div className="mx-auto max-w-[820px] mt-6 flex flex-wrap items-center justify-center gap-2">
              <span className="text-[12px] text-zc-text-dim">Try</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => { setQuery(example); void start(example, false); }}
                  className="rounded-full border border-zc-border bg-zc-surface-deep px-3 py-1 text-[12px] text-zc-text-secondary hover:text-zc-gold hover:border-[rgba(196,168,130,0.35)]"
                >
                  {example}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mx-auto max-w-[820px] mt-6 rounded-xl border border-[rgba(238,107,106,0.3)] bg-[rgba(238,107,106,0.08)] px-4 py-3 text-[14px] text-zc-error"
            >
              {error}
            </p>
          )}

          {running && <Progress trace={trace} question={pendingQuestion} />}

          {thread.map((turn, index) => (
            <Comparison
              key={`${turn.run.stored_run_id}-${index}`}
              run={turn.run}
              question={turn.question}
              isFollowUp={index > 0}
            />
          ))}

          {latest && !running && (
            <FollowUp
              exhausted={thread.length >= MAX_TURNS}
              onAsk={(question) => void start(question, Boolean(session))}
            />
          )}

          {!hasOutput && recent.length > 0 && <Recent cards={recent} />}
        </main>

        <ZenCubFooter />
      </div>
    </div>
  );
}

// --- live graph progress ---------------------------------------------------

function Progress({ trace, question }: { trace: RagGraphTraceEntry[]; question: string }) {
  const reached = STAGES.map((stage) => trace.filter((entry) => stage.match(entry.node)));
  const lastActive = reached.reduce((last, entries, index) => (entries.length > 0 ? index : last), -1);
  const branches = trace.filter((entry) => entry.node.startsWith("compare_instructor:"));
  const checks = trace.filter((entry) => entry.node.startsWith("compare_verify:"));

  return (
    <section className="mx-auto max-w-[820px] mt-10">
      <p className="text-[12px] text-zc-text-dim mb-4">
        Comparing instructors on “{question}”
      </p>
      <ol className="m-0 list-none p-0 space-y-2.5">
        {STAGES.map((stage, index) => {
          const entries = reached[index];
          const done = index < lastActive;
          const active = index === lastActive;
          const pending = !done && !active;
          return (
            <li
              key={stage.key}
              className="flex items-start gap-3 rounded-xl border px-4 py-3"
              style={{
                borderColor: active ? "rgba(196,168,130,0.35)" : "#2c2a27",
                background: pending ? "transparent" : "#242220",
                opacity: pending ? 0.45 : 1,
              }}
            >
              <span className="mt-0.5 shrink-0">
                {done && <Check size={15} className="text-zc-gold" />}
                {active && <Loader2 size={15} className="animate-spin text-zc-gold" />}
                {pending && <span className="block h-[15px] w-[15px] rounded-full border border-zc-border" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-zc-text-primary">{stage.label}</span>
                <span className="block text-[12px] text-zc-text-dim mt-0.5">{stage.detail}</span>

                {/* The fan-out, drawn from the real branch nodes. */}
                {stage.key === "analyze" && branches.length > 0 && (
                  <span className="mt-2 block space-y-1">
                    {branches.map((branch) => (
                      <span key={branch.node} className="flex items-center gap-2 text-[12px] text-zc-text-secondary">
                        <Split size={12} className="text-zc-text-dim shrink-0" />
                        {branch.label}
                      </span>
                    ))}
                  </span>
                )}
                {stage.key === "verify" && checks.length > 0 && (
                  <span className="mt-2 block text-[12px] text-zc-text-secondary">
                    {checks.length} claim{checks.length === 1 ? "" : "s"} checked
                  </span>
                )}
              </span>
              {entries.length > 0 && (
                <span className="shrink-0 text-[11px] text-zc-text-dim tabular-nums">
                  {entries.length}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// --- the comparison --------------------------------------------------------

function Comparison({
  run,
  question,
  isFollowUp,
}: {
  run: RagStoredInstructorCompareRun;
  question: string;
  isFollowUp: boolean;
}) {
  const { comparison, quality } = run;
  const verified = run.claim_verifications.filter((item) => item.passed).length;
  const rejected = run.claim_verifications.length - verified;

  return (
    <section className="mx-auto max-w-[820px] mt-10">
      {isFollowUp && (
        <p className="text-[12px] text-zc-gold mb-2 flex items-center gap-1.5">
          <ArrowRight size={12} /> Follow-up, same panel
        </p>
      )}
      <header className="border-b border-zc-border pb-5">
        <h2 className="text-[20px] sm:text-[24px] font-semibold text-zc-text-primary m-0 leading-snug">
          {comparison.topic}
        </h2>
        <p className="mt-2 text-[13px] text-zc-text-dim m-0">
          {question} · {run.instructor_count} instructors · {run.evidence_count} clips
        </p>
      </header>

      {comparison.shared_principles.length > 0 && (
        <Block icon={<Scale size={14} />} title="Where they agree">
          <ul className="m-0 list-none p-0 space-y-4">
            {comparison.shared_principles.map((claim, index) => (
              <li key={index}>
                <p className="text-[15px] leading-relaxed text-zc-text-body m-0">{claim.summary}</p>
                <Citations citations={claim.citations} />
              </li>
            ))}
          </ul>
        </Block>
      )}

      {comparison.important_differences.length > 0 && (
        <Block icon={<Split size={14} />} title="Where they split">
          <ul className="m-0 list-none p-0 space-y-5">
            {comparison.important_differences.map((difference, index) => (
              <li key={index}>
                <p className="text-[14px] font-medium text-zc-text-primary m-0">{difference.subject}</p>
                <p className="text-[15px] leading-relaxed text-zc-text-body mt-1 m-0">{difference.explanation}</p>
                {difference.instructor_names.length > 0 && (
                  <p className="text-[12px] text-zc-text-dim mt-1.5 m-0">
                    {difference.instructor_names.join(" · ")}
                  </p>
                )}
                <Citations citations={difference.citations} />
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block icon={<Users size={14} />} title="How each one teaches it">
        <div className="space-y-3">
          {comparison.instructors.map((instructor) => (
            <InstructorCard key={instructor.creator_slug} instructor={instructor} />
          ))}
        </div>
      </Block>

      {comparison.decision_guide.length > 0 && (
        <Block icon={<ArrowRight size={14} />} title="What to drill">
          <ul className="m-0 pl-5 space-y-2">
            {comparison.decision_guide.map((item, index) => (
              <li key={index} className="text-[15px] leading-relaxed text-zc-text-body">{item}</li>
            ))}
          </ul>
        </Block>
      )}

      {comparison.caveats.length > 0 && (
        <div className="mt-6 rounded-xl border border-zc-border bg-zc-surface-deep px-4 py-3">
          <p className="text-[12px] text-zc-text-dim m-0 mb-1.5">Worth knowing</p>
          <ul className="m-0 pl-4 space-y-1">
            {comparison.caveats.map((caveat, index) => (
              <li key={index} className="text-[13px] text-zc-text-secondary leading-relaxed">{caveat}</li>
            ))}
          </ul>
        </div>
      )}

      {/* How it was built. Not decoration: it is the difference between a
          summary and a checked one, so it says exactly what was checked. */}
      <footer className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zc-border pt-4 text-[11px] text-zc-text-dim">
        <span className="inline-flex items-center gap-1.5">
          <Check size={11} className="text-zc-gold" />
          {verified} of {run.claim_verifications.length} claims verified
          {rejected > 0 && <span className="text-zc-text-dim"> · {rejected} dropped</span>}
        </span>
        <span>{quality.score}% quality</span>
        <span>{run.instructor_count} analysis branches</span>
        <span>{run.usage.reported_calls} model calls</span>
        <span>{run.checkpoint_count} checkpoints</span>
        <span>{Math.round(run.total_ms / 1000)}s</span>
        <span>{run.model}</span>
        <ShareLink id={run.stored_run_id} />
      </footer>
    </section>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <h3 className="flex items-center gap-2 text-[12px] uppercase tracking-[0.14em] text-zc-gold m-0 mb-3">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

function InstructorCard({ instructor }: { instructor: RagInstructorAnalysis }) {
  return (
    <article className="rounded-xl border border-zc-border bg-zc-surface p-4 sm:p-5">
      <h4 className="text-[15px] font-medium text-zc-text-primary m-0">{instructor.creator_name}</h4>
      <p className="text-[14px] leading-relaxed text-zc-text-body mt-2 m-0">{instructor.approach_summary}</p>

      {instructor.key_details.length > 0 && (
        <ul className="mt-3 m-0 pl-4 space-y-1">
          {instructor.key_details.map((detail, index) => (
            <li key={index} className="text-[13px] text-zc-text-secondary leading-relaxed">{detail}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {instructor.best_for.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-zc-text-dim m-0 mb-1">Good for</p>
            <p className="text-[13px] text-zc-text-secondary m-0">{instructor.best_for.join(" · ")}</p>
          </div>
        )}
        {instructor.limitations.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-zc-text-dim m-0 mb-1">Watch out</p>
            <p className="text-[13px] text-zc-text-secondary m-0">{instructor.limitations.join(" · ")}</p>
          </div>
        )}
      </div>

      <Citations citations={instructor.citations} />
    </article>
  );
}

function Citations({ citations }: { citations: RagAnswerCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {citations.map((citation, index) => {
        const label = `${citation.title} ${secondsLabel(citation.start_seconds)}`;
        return citation.watch_url ? (
          <a
            key={`${citation.watch_url}-${index}`}
            href={citation.watch_url}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-full truncate rounded-full border border-zc-border bg-zc-surface-deep px-2.5 py-1 text-[11px] text-zc-text-secondary no-underline hover:text-zc-gold hover:border-[rgba(196,168,130,0.35)]"
          >
            {label}
          </a>
        ) : (
          <span
            key={`${citation.title}-${index}`}
            className="max-w-full truncate rounded-full border border-zc-border px-2.5 py-1 text-[11px] text-zc-text-dim"
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function ShareLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const url = `${window.location.origin}/c/${id}`;
        void navigator.clipboard?.writeText(url).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          },
          () => { window.prompt("Copy this link", url); },
        );
      }}
      className="inline-flex items-center gap-1.5 border-none bg-transparent p-0 text-[11px] text-zc-text-dim hover:text-zc-gold"
    >
      <Link2 size={11} />
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}

// --- follow-ups ------------------------------------------------------------

function FollowUp({ exhausted, onAsk }: { exhausted: boolean; onAsk: (question: string) => void }) {
  const [value, setValue] = useState("");

  if (exhausted) {
    return (
      <p className="mx-auto max-w-[820px] mt-6 text-[12px] text-zc-text-dim">
        That is as far as this session goes. Start a new comparison above.
      </p>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim().length < 3) return;
        onAsk(value);
        setValue("");
      }}
      className="mx-auto max-w-[820px] mt-6"
    >
      <div className="flex items-center gap-2.5 rounded-xl bg-zc-surface border border-zc-border px-4 py-2.5 focus-within:border-[rgba(196,168,130,0.4)]">
        <ArrowRight size={15} className="text-zc-text-dim shrink-0" />
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Ask a follow-up, same instructors…"
          aria-label="Follow-up question"
          maxLength={300}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-[14px] text-zc-text-primary"
        />
        <button
          type="submit"
          disabled={value.trim().length < 3}
          className="shrink-0 rounded-full border border-zc-border bg-zc-surface-deep px-3 py-1 text-[12px] text-zc-text-secondary disabled:opacity-40 hover:text-zc-gold"
        >
          Ask
        </button>
      </div>
      <p className="mt-2 text-[11px] text-zc-text-dim">
        A follow-up reuses the same instructors and their clips, so it stays on the same panel.
      </p>
    </form>
  );
}

// --- recent ----------------------------------------------------------------

function Recent({ cards }: { cards: RecentCard[] }) {
  return (
    <section className="mx-auto max-w-[820px] mt-14 mb-4">
      <h2 className="text-[12px] uppercase tracking-[0.14em] text-zc-text-dim m-0 mb-3">Recently compared</h2>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {cards.map((card) => (
          <a
            key={card.id}
            href={`/c/${card.id}`}
            className="rounded-xl border border-zc-border bg-zc-surface p-4 no-underline hover:border-[rgba(196,168,130,0.35)]"
          >
            <p className="text-[14px] text-zc-text-primary m-0 leading-snug">{card.topic}</p>
            <p className="text-[12px] text-zc-text-dim mt-1.5 m-0">{card.instructors.join(" · ")}</p>
            <p className="text-[11px] text-zc-text-dim mt-2 m-0 flex items-center gap-3">
              <span className="inline-flex items-center gap-1"><Scale size={10} />{card.shared_principle_count} agreed</span>
              <span className="inline-flex items-center gap-1"><X size={10} />{card.difference_count} split</span>
            </p>
          </a>
        ))}
      </div>
    </section>
  );
}
