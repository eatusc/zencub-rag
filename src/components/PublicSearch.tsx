"use client";

import { CornerDownRight, ExternalLink, Loader2, Search, Send, Sparkles } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  RagAnswer,
  RagAskResponse,
  RagSearchResponse,
  RagSearchResult,
} from "@/lib/types";
import { timestampUrl } from "@/lib/ragUtils";
import { ZenCubFooter, ZenCubHeader } from "@/components/ZenCubChrome";

type Mode = "keyword" | "semantic" | "ask";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "keyword", label: "Text", hint: "Exact words, the way they were said on the video." },
  { id: "semantic", label: "Meaning", hint: "Finds the idea even when the words are different." },
  { id: "ask", label: "Ask AI", hint: "A written answer, cited back to the exact clips." },
];

const EXAMPLES = [
  "escaping side control",
  "closed guard breaks",
  "triangle choke setup",
  "half guard sweeps",
];

function isMode(value: string | null): value is Mode {
  return value === "keyword" || value === "semantic" || value === "ask";
}

type FollowUpTurn = { question: string; answer: RagAnswer };

// The server keeps at most 6 conversation turns and drops the middle ones when
// there are more (normalizeConversation in ragPipeline.ts). Cap the thread here
// so the opening answer and every follow-up survive intact, rather than having
// turn 2 silently vanish once the thread gets long.
const MAX_CONVERSATION_TURNS = 6;

// How many of the previous answer's clips to carry into a follow-up. /api/rag/ask
// prepends this prior context to the freshly retrieved candidates and reranks
// only the first 12, so sending all 8 would fill the pool with the old clips and
// the follow-up would never see anything retrieved for the new question.
const MAX_CONTEXT_IDS = 4;

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
    ? `${secondsLabel(start)}-${secondsLabel(end)}`
    : secondsLabel(start);
}

const THROTTLED = "That is a lot of searching. Give it a minute and try again.";

async function errorMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.status === 429) {
    // Two different 429s reach here. The per-IP sliding window sets retry-after
    // and its server copy is dry, so keep ours. The site-wide daily ask budget
    // sends no retry-after and its message is the useful one: it tells the user
    // that text and semantic search still work.
    return response.headers.get("retry-after") ? THROTTLED : body.error ?? THROTTLED;
  }
  return body.error ?? fallback;
}

export function PublicSearch() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("keyword");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<RagSearchResult[] | null>(null);
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [searched, setSearched] = useState("");

  // Follow-up thread. `contextIds` is the rolling set of clips the last answer
  // was built from; carrying it forward is what keeps a follow-up anchored to
  // the video the reader is already looking at.
  const [thread, setThread] = useState<FollowUpTurn[]>([]);
  const [contextIds, setContextIds] = useState<string[]>([]);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  const search = useCallback(async (rawQuery: string, searchMode: Mode) => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < 2) return;

    setLoading(true);
    setError(null);
    setAnswer(null);
    setResults(null);
    setThread([]);
    setContextIds([]);
    setFollowUpError(null);

    // Keep the URL in step so a result page can be linked or reloaded.
    const params = new URLSearchParams({ q: trimmed, mode: searchMode });
    window.history.replaceState(null, "", `/?${params}`);

    try {
      if (searchMode === "ask") {
        const response = await fetch("/api/rag/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
        });
        if (!response.ok) {
          setError(await errorMessage(response, "Could not generate an answer."));
          return;
        }
        const data = (await response.json()) as RagAskResponse;
        setAnswer(data.answer);
        setContextIds(data.context_ids);
      } else {
        const endpoint = searchMode === "semantic" ? "/api/rag/vector-search" : "/api/rag/search";
        const response = await fetch(`${endpoint}?q=${encodeURIComponent(trimmed)}&limit=12`);
        if (!response.ok) {
          setError(await errorMessage(response, "Search failed."));
          return;
        }
        const data = (await response.json()) as RagSearchResponse;
        setResults(data.results);
      }
      setSearched(trimmed);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // A follow-up is a normal /api/rag/ask call with two extras: the conversation
  // so far, and the ids of the clips the last answer cited. The server merges
  // those clips into the candidate pool before reranking, so "what if he
  // cross-faces me?" resolves against the same instructional the reader just
  // watched instead of drifting to an unrelated video.
  const askFollowUp = useCallback(async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (question.length < 2 || !answer) return;

    setFollowUpLoading(true);
    setFollowUpError(null);

    const conversation = [
      { question: searched, answer: answer.answer },
      ...thread.map((turn) => ({ question: turn.question, answer: turn.answer.answer })),
    ];

    try {
      const response = await fetch("/api/rag/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: question,
          conversation,
          context_ids: contextIds.slice(0, MAX_CONTEXT_IDS),
        }),
      });
      if (!response.ok) {
        setFollowUpError(await errorMessage(response, "Could not answer that follow-up."));
        return;
      }
      const data = (await response.json()) as RagAskResponse;
      setThread((turns) => [...turns, { question, answer: data.answer }]);
      // Roll the window forward so the next follow-up anchors on the clips that
      // answered this one, not the ones from the original question.
      setContextIds(data.context_ids);
    } catch {
      setFollowUpError("Could not reach the server. Try again.");
    } finally {
      setFollowUpLoading(false);
    }
  }, [answer, contextIds, searched, thread]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!loading) void search(query, mode);
  }

  function runExample(example: string) {
    setQuery(example);
    void search(example, mode);
  }

  // Run the query in the URL on first load, so /?q=armbar&mode=semantic is a
  // shareable link rather than just a prefilled box.
  const ranInitialQuery = useRef(false);
  useEffect(() => {
    if (ranInitialQuery.current) return;
    ranInitialQuery.current = true;

    const params = new URLSearchParams(window.location.search);
    const initialQuery = params.get("q")?.trim() ?? "";
    if (initialQuery.length < 2) return;

    const initialMode = params.get("mode");
    const resolvedMode: Mode = isMode(initialMode) ? initialMode : "keyword";

    setQuery(initialQuery);
    setMode(resolvedMode);
    void search(initialQuery, resolvedMode);
  }, [search]);

  const activeMode = MODES.find((item) => item.id === mode);
  const hasOutput = Boolean(answer || results);

  return (
    <div className="relative min-h-dvh overflow-hidden">
      {/* Same warm radial glow the marketing hero uses. */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 h-[420px] bg-[radial-gradient(ellipse_at_50%_0%,rgba(196,168,130,0.06)_0%,transparent_70%)]" />

      {/* Column layout so the footer sits at the bottom of the viewport when
          the page has no results yet, rather than floating mid-screen. */}
      <div className="relative mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col px-5 sm:px-7">
        <ZenCubHeader />

        <main className="flex-1">
          <section className={hasOutput ? "text-center pt-10 pb-8" : "text-center pt-16 sm:pt-24 pb-10"}>
            <p className="text-[11px] tracking-[0.18em] text-zc-gold uppercase m-0">Film Study</p>
            <h1 className="text-[28px] sm:text-[46px] font-semibold leading-[1.1] tracking-tight mt-4 mx-auto max-w-[760px] text-balance text-zc-text-primary">
              Search what the instructors{" "}
              <span className="text-zc-gold font-medium">actually said.</span>
            </h1>
            {!hasOutput && (
              <p className="text-[15px] sm:text-[17px] text-zc-text-secondary leading-relaxed mt-5 mx-auto max-w-[600px]">
                Thousands of BJJ instructionals, transcribed and searchable by
                word or by meaning. Every result jumps to the exact second it
                was said.
              </p>
            )}
          </section>

          <form onSubmit={submit} className="mx-auto max-w-[820px]">
            <div className="flex items-center gap-2.5 rounded-xl bg-zc-surface border border-zc-border px-4 py-3 focus-within:border-[rgba(196,168,130,0.4)]">
              {mode === "ask"
                ? <Sparkles size={17} className="text-zc-text-dim shrink-0" />
                : <Search size={17} className="text-zc-text-dim shrink-0" />}
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={mode === "ask"
                  ? "Ask a question about technique…"
                  : "Search instructionals…"}
                aria-label={mode === "ask" ? "Ask a question" : "Search instructionals"}
                maxLength={1000}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-[15px] text-zc-text-primary"
              />
              <button
                type="submit"
                disabled={loading || query.trim().length < 2}
                className="shrink-0 flex items-center gap-2 rounded-full bg-zc-gold px-4 py-1.5 text-[13px] font-semibold text-[#1a1917] disabled:opacity-40 hover:opacity-90"
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                {mode === "ask" ? (loading ? "Thinking…" : "Ask") : "Search"}
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" aria-label="Search mode" className="flex gap-1.5">
                {MODES.map((item) => {
                  const active = mode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setMode(item.id)}
                      className="rounded-md px-3 py-1.5 text-[13px] font-medium border-none"
                      style={{
                        background: active ? "#c4a882" : "#242220",
                        color: active ? "#1a1917" : "#b9b2a6",
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              {activeMode && (
                <p className="text-[12px] text-zc-text-dim m-0">{activeMode.hint}</p>
              )}
            </div>
          </form>

          {!hasOutput && !loading && (
            <div className="mx-auto max-w-[820px] mt-6 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-zc-text-dim">Try</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => runExample(example)}
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

          {loading && !hasOutput && (
            <p className="mx-auto max-w-[820px] mt-10 text-center text-[13px] text-zc-text-dim">
              {mode === "ask" ? "Reading the tape…" : "Searching…"}
            </p>
          )}

          {answer && (
            <>
              <AnswerBlock answer={answer} />
              {thread.map((turn, index) => (
                <AnswerBlock key={`${turn.question}-${index}`} answer={turn.answer} question={turn.question} />
              ))}
              <FollowUps
                suggestion={(thread.at(-1)?.answer ?? answer).suggested_follow_up}
                loading={followUpLoading}
                error={followUpError}
                // +1 for the opening question, which is itself a conversation turn.
                exhausted={thread.length + 1 >= MAX_CONVERSATION_TURNS}
                turnCount={thread.length}
                onAsk={askFollowUp}
              />
            </>
          )}

          {results && (
            <section className="mx-auto max-w-[820px] mt-10">
              <p className="text-[12px] text-zc-text-dim mb-3">
                {results.length} {results.length === 1 ? "clip" : "clips"} for “{searched}”
              </p>
              {results.length === 0 && (
                <p className="text-[14px] text-zc-text-secondary">
                  Nothing matched. Try different wording, or switch to Meaning.
                </p>
              )}
              <div className="space-y-3">
                {results.map((result) => (
                  <ResultCard key={result.id} result={result} />
                ))}
              </div>
            </section>
          )}
        </main>

        <ZenCubFooter />
      </div>
    </div>
  );
}

// Transcript chunks run to a few thousand characters. Show an excerpt by
// default: it reads better, and the public page does not dump long verbatim
// stretches of someone's instructional until a reader asks for them.
const SNIPPET_CHARS = 340;

function ResultCard({ result }: { result: RagSearchResult }) {
  const [expanded, setExpanded] = useState(false);
  const title = result.metadata?.video_title || result.video_id;
  const watchUrl = timestampUrl(result.metadata?.video_url, Number(result.start_seconds) || 0);
  const instructor = result.metadata?.instructor_name || result.metadata?.channel_name;
  const isLong = result.text.length > SNIPPET_CHARS;
  const shown = expanded || !isLong
    ? result.text
    : `${result.text.slice(0, SNIPPET_CHARS).trimEnd()}…`;

  return (
    <article className="rounded-xl border border-zc-border bg-zc-surface p-4 sm:p-5 hover:border-zc-border-subtle">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium leading-snug text-zc-text-primary m-0">{title}</h2>
          {instructor && (
            <p className="mt-1 text-[12px] text-zc-text-dim m-0">{instructor}</p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-zc-surface-deep border border-zc-border px-2.5 py-1 text-[11px] text-zc-text-secondary tabular-nums">
          {timestampRangeLabel(result.start_seconds, result.end_seconds)}
        </span>
      </div>

      <p className="mt-3 text-[14px] leading-relaxed text-zc-text-body">{shown}</p>

      <div className="mt-3 flex items-center gap-5">
        {watchUrl && (
          <a
            href={watchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-[13px] text-zc-gold no-underline hover:underline"
          >
            Watch this moment
            <ExternalLink size={12} />
          </a>
        )}
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-[13px] text-zc-text-dim hover:text-zc-text-primary"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </article>
  );
}

// `question` is set for follow-up turns only; the opening answer already has the
// reader's question sitting in the search box above it.
function AnswerBlock({ answer, question }: { answer: RagAnswer; question?: string }) {
  return (
    <section className="mx-auto max-w-[820px] mt-10">
      {question && (
        <div className="mb-3 flex items-start gap-2.5">
          <CornerDownRight size={15} className="mt-[3px] shrink-0 text-zc-gold" />
          <p className="text-[15px] font-medium leading-snug text-zc-text-primary m-0">{question}</p>
        </div>
      )}
      <div className="rounded-xl border border-zc-border bg-zc-surface p-5 sm:p-6">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zc-text-body m-0">
          {answer.answer}
        </p>

        {answer.key_takeaways.length > 0 && (
          <ul className="mt-5 pt-4 border-t border-zc-border space-y-2 list-none p-0">
            {answer.key_takeaways.map((item) => (
              <li key={item} className="flex gap-2.5 text-[14px] text-zc-text-body">
                <span className="text-zc-gold shrink-0">&bull;</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}

        {answer.caveats.length > 0 && (
          <div className="mt-4 rounded-lg bg-zc-surface-deep px-3.5 py-2.5">
            {answer.caveats.map((caveat) => (
              <p key={caveat} className="text-[12px] text-zc-text-dim m-0">{caveat}</p>
            ))}
          </div>
        )}
      </div>

      {answer.citations.length > 0 && (
        <div className="mt-5">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zc-text-dim mb-2.5">
            Sources
          </h2>
          <div className="space-y-2">
            {answer.citations.map((citation, index) => (
              <a
                key={`${citation.citation}-${index}`}
                href={citation.watch_url ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-start justify-between gap-4 rounded-xl border border-zc-border bg-zc-surface px-4 py-3 no-underline hover:border-[rgba(196,168,130,0.35)]"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-medium leading-snug text-zc-text-primary m-0">
                    {citation.title}
                  </p>
                  {citation.channel && (
                    <p className="mt-1 text-[12px] text-zc-text-dim m-0">{citation.channel}</p>
                  )}
                </div>
                <span className="shrink-0 inline-flex items-center gap-1.5 text-[12px] text-zc-gold tabular-nums">
                  {secondsLabel(citation.start_seconds)}
                  <ExternalLink size={11} />
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// Sits under the last answer. Keeps its own input state so typing does not
// re-render the answers above it.
function FollowUps({
  suggestion,
  loading,
  error,
  exhausted,
  turnCount,
  onAsk,
}: {
  suggestion: string | null;
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  turnCount: number;
  onAsk: (question: string) => void;
}) {
  const [value, setValue] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // Bring a finished follow-up into view. Answers take several seconds, so the
  // reader has usually scrolled away by the time one lands.
  const seenTurns = useRef(turnCount);
  useEffect(() => {
    if (turnCount > seenTurns.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    seenTurns.current = turnCount;
  }, [turnCount]);

  function send(event: FormEvent) {
    event.preventDefault();
    if (loading || value.trim().length < 2) return;
    onAsk(value);
    setValue("");
  }

  if (exhausted) {
    return (
      <section className="mx-auto max-w-[820px] mt-8">
        <p className="rounded-xl border border-zc-border bg-zc-surface-deep px-4 py-3 text-[13px] text-zc-text-dim m-0">
          That is as far as this thread goes. Start a new search above to keep digging.
        </p>
        <div ref={endRef} />
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-[820px] mt-8">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zc-text-dim mb-2.5">
        Keep going
      </h2>

      {/* The model proposes a next question with every answer. Offer it as one
          tap rather than making the reader think one up. */}
      {suggestion && !loading && (
        <button
          type="button"
          onClick={() => onAsk(suggestion)}
          className="mb-3 w-full text-left rounded-xl border border-zc-border bg-zc-surface-deep px-4 py-3 text-[13px] text-zc-text-secondary hover:text-zc-gold hover:border-[rgba(196,168,130,0.35)]"
        >
          {suggestion}
        </button>
      )}

      <form onSubmit={send}>
        <div className="flex items-center gap-2.5 rounded-xl bg-zc-surface border border-zc-border px-4 py-3 focus-within:border-[rgba(196,168,130,0.4)]">
          <Sparkles size={17} className="text-zc-text-dim shrink-0" />
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Ask a follow-up about these clips…"
            aria-label="Ask a follow-up"
            maxLength={1000}
            disabled={loading}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[15px] text-zc-text-primary disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || value.trim().length < 2}
            className="shrink-0 flex items-center gap-2 rounded-full bg-zc-gold px-4 py-1.5 text-[13px] font-semibold text-[#1a1917] disabled:opacity-40 hover:opacity-90"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {loading ? "Thinking…" : "Ask"}
          </button>
        </div>
      </form>

      <p className="mt-2 text-[12px] text-zc-text-dim m-0">
        Follow-ups keep the clips above in view and search for new ones.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-[rgba(238,107,106,0.3)] bg-[rgba(238,107,106,0.08)] px-4 py-3 text-[14px] text-zc-error"
        >
          {error}
        </p>
      )}

      <div ref={endRef} />
    </section>
  );
}
