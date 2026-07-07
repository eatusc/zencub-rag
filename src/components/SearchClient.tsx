"use client";

import { Brain, Database, ExternalLink, FileText, Loader2, MessageSquare, Search, Workflow } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { ragExamples } from "@/lib/ragExamples";
import type { RagAnalysis, RagAnalyzeResponse, RagAnswer, RagAskResponse, RagSearchResponse, RagSearchResult } from "@/lib/types";

function secondsLabel(value: number | string | null) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric ?? NaN)) return "0:00";
  const total = Math.max(0, Math.floor(numeric as number));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function titleFor(result: RagSearchResult) {
  return result.metadata?.video_title || result.video_id;
}

function shortTimeRange(start: number, end: number) {
  return `${secondsLabel(start)}-${secondsLabel(end)}`;
}

type Tab = "search" | "map";

const pipeline = [
  {
    icon: Database,
    title: "Source snapshot",
    detail: "PROD transcript/video/technique rows are copied into TEST-only rag_ tables.",
    status: "done",
  },
  {
    icon: FileText,
    title: "Chunk transcripts",
    detail: "Timestamped transcript segments are grouped into 12,104 citation-ready chunks.",
    status: "done",
  },
  {
    icon: Search,
    title: "Retrieve evidence",
    detail: "Text search returns matching chunks; Ask uses hybrid evidence or text fallback when vectors are sparse.",
    status: "live",
  },
  {
    icon: Brain,
    title: "Embed for meaning",
    detail: "4,352 chunks now have vectors in rag_transcript_chunks.embedding for semantic search testing.",
    status: "live",
  },
  {
    icon: MessageSquare,
    title: "Generate answers",
    detail: "The Ask button retrieves sources, sends them to the answer model, and returns cited takeaways.",
    status: "live",
  },
];

const dataTables = [
  ["rag_videos", "2,402", "Video title, source URL, platform, channel, thumbnail, slug"],
  ["rag_video_transcripts", "2,298", "Raw transcript JSON segments and transcript metadata"],
  ["rag_techniques", "2,844", "Technique names, positions, summaries, steps, timestamps"],
  ["rag_video_attributions", "2,385", "Creator/instructor attribution links"],
  ["rag_creators", "468", "Canonical creator names, aliases, opt-out field"],
  ["rag_transcript_chunks", "12,104", "Searchable timestamped evidence chunks"],
];

export function SearchClient() {
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("knee cut");
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [askLoading, setAskLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RagAnalysis | null>(null);
  const [analysisModel, setAnalysisModel] = useState("");
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [answerModel, setAnswerModel] = useState("");
  const [answerRetrieval, setAnswerRetrieval] = useState<"vector" | "text" | "hybrid" | "">("");

  const resultCountLabel = useMemo(() => {
    if (!searchedQuery) return "Ready";
    return `${results.length} result${results.length === 1 ? "" : "s"}`;
  }, [results.length, searchedQuery]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    await runSearch(trimmed);
  }

  async function runSearch(trimmed: string) {
    setLoading(true);
    setError(null);
    setAnalysisError(null);
    setAnalysis(null);
    setAnswer(null);
    try {
      const response = await fetch(`/api/rag/search?q=${encodeURIComponent(trimmed)}&limit=12`);
      const payload = (await response.json()) as RagSearchResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Search failed");
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
    setError(null);
    setAnalysisError(null);
    setAnalysis(null);
    setAnswer(null);
    try {
      const response = await fetch(`/api/rag/vector-search?q=${encodeURIComponent(trimmed)}&limit=12`);
      const payload = (await response.json()) as RagSearchResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Semantic search failed");
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
    setAnalysisError(null);
    try {
      const response = await fetch("/api/rag/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const payload = (await response.json()) as RagAnalyzeResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Analysis failed");
      setAnalysis(payload.analysis);
      setAnalysisModel(payload.model);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed");
      setAnalysis(null);
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function askQuestion() {
    const trimmed = searchedQuery || query.trim();
    if (trimmed.length < 2) return;

    setAskLoading(true);
    setAnalysisError(null);
    try {
      const response = await fetch("/api/rag/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, retrieval: "auto" }),
      });
      const payload = (await response.json()) as RagAskResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Ask failed");
      setAnswer(payload.answer);
      setAnswerModel(payload.model);
      setAnswerRetrieval(payload.retrieval);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Ask failed");
      setAnswer(null);
    } finally {
      setAskLoading(false);
    }
  }

  function useExample(nextQuery: string) {
    setQuery(nextQuery);
    setTab("search");
    void runSearch(nextQuery);
  }

  return (
    <section className="workspace">
      <div className="tabs" role="tablist" aria-label="ZenCub RAG views">
        <button className={tab === "search" ? "active" : ""} type="button" role="tab" aria-selected={tab === "search"} onClick={() => setTab("search")}>
          <Search aria-hidden="true" size={17} />
          <span>Search</span>
        </button>
        <button className={tab === "map" ? "active" : ""} type="button" role="tab" aria-selected={tab === "map"} onClick={() => setTab("map")}>
          <Workflow aria-hidden="true" size={17} />
          <span>System Map</span>
        </button>
      </div>

      {tab === "search" ? (
        <>
          <form className="searchbar" onSubmit={submit}>
            <Search aria-hidden="true" size={19} />
            <input
              aria-label="Search transcript chunks"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search knee cut, saddle entries, crossface details..."
            />
            <span className="tooltip-wrap">
              <button type="submit" disabled={loading || query.trim().length < 2} aria-describedby="tip-normal-search">
                {loading ? <Loader2 aria-hidden="true" className="spin" size={18} /> : <Search aria-hidden="true" size={18} />}
                <span>Search</span>
              </button>
              <span className="tooltip-bubble" id="tip-normal-search" role="tooltip">
                Keyword search across all transcript chunks. Best for exact terms like knee cut, saddle, or kimura.
              </span>
            </span>
          </form>

          <div className="search-actions">
            <span className="tooltip-wrap">
              <button type="button" onClick={runVectorSearch} disabled={loading || query.trim().length < 2} aria-describedby="tip-semantic-search">
                <Brain aria-hidden="true" size={17} />
                <span>Semantic Search</span>
              </button>
              <span className="tooltip-bubble" id="tip-semantic-search" role="tooltip">
                Meaning search over embedded chunks. Best for concept matches when the transcript may use different words.
              </span>
            </span>
            <span className="tooltip-wrap">
              <button type="button" onClick={askQuestion} disabled={askLoading || (searchedQuery || query.trim()).length < 2} aria-describedby="tip-ask">
                {askLoading ? <Loader2 aria-hidden="true" className="spin" size={17} /> : <MessageSquare aria-hidden="true" size={17} />}
                <span>{askLoading ? "Asking..." : "Ask"}</span>
              </button>
              <span className="tooltip-bubble" id="tip-ask" role="tooltip">
                Generates an answer from retrieved clips, using hybrid retrieval and returning citations with watch links.
              </span>
            </span>
          </div>

          <div className="summary-row">
            <span>{resultCountLabel}</span>
            {searchedQuery ? <span>Query: {searchedQuery}</span> : <span>Text search over `rag_transcript_chunks`</span>}
          </div>

          {error ? <div className="error-box">{error}</div> : null}

          {results.length > 0 ? (
            <section className="analysis-action">
              <div>
                <p className="section-kicker">Next step</p>
                <h2>Turn these search results into a watch plan</h2>
                <p>Analyze the top transcript chunks and rank the most useful moments for the query.</p>
              </div>
              <button type="button" onClick={analyzeResults} disabled={analysisLoading}>
                {analysisLoading ? <Loader2 aria-hidden="true" className="spin" size={18} /> : <MessageSquare aria-hidden="true" size={18} />}
                <span>{analysisLoading ? "Analyzing..." : "Analyze Results"}</span>
              </button>
            </section>
          ) : null}

          {analysisError ? <div className="error-box">{analysisError}</div> : null}

          {answer ? (
            <section className="answer-panel">
              <div className="analysis-header">
                <div>
                  <p className="section-kicker">Generated Answer</p>
                  <h2>{searchedQuery || query}</h2>
                </div>
                <span>{answerModel} · {answerRetrieval}</span>
              </div>
              <p className="answer-copy">{answer.answer}</p>
              <div className="analysis-grid">
                <div>
                  <h3>Takeaways</h3>
                  <ul>{answer.key_takeaways.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
                <div>
                  <h3>Citations</h3>
                  <div className="citation-list">
                    {answer.citations.map((citation) => (
                      <a href={citation.watch_url ?? "#"} target="_blank" rel="noreferrer" key={`${citation.title}-${citation.start_seconds}`}>
                        {citation.title} · {shortTimeRange(citation.start_seconds, citation.end_seconds)}
                      </a>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>Follow-up searches</h3>
                  <div className="next-searches">
                    {answer.follow_up_searches.map((item) => (
                      <button type="button" key={item} onClick={() => useExample(item)}>{item}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>Caveats</h3>
                  <ul>{answer.caveats.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              </div>
            </section>
          ) : null}

          {analysis ? (
            <section className="analysis-panel">
              <div className="analysis-header">
                <div>
                  <p className="section-kicker">Analysis</p>
                  <h2>{searchedQuery || query}</h2>
                </div>
                <span>{analysisModel}</span>
              </div>

              <p className="analysis-summary">{analysis.summary}</p>

              <div className="moment-list">
                {analysis.best_moments.map((moment) => (
                  <article className="moment-item" key={`${moment.rank}-${moment.title}-${moment.start_seconds}`}>
                    <div className="moment-rank">{moment.rank}</div>
                    <div>
                      <div className="moment-heading">
                        <h3>{moment.title}</h3>
                        <span>{shortTimeRange(moment.start_seconds, moment.end_seconds)}</span>
                      </div>
                      <p><strong>{moment.focus}</strong> {moment.why}</p>
                      <div className="moment-actions">
                        <span>{moment.citation}</span>
                        {moment.watch_url ? (
                          <a href={moment.watch_url} target="_blank" rel="noreferrer">
                            <ExternalLink aria-hidden="true" size={15} />
                            Watch
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              <div className="analysis-grid">
                <div>
                  <h3>Key details</h3>
                  <ul>{analysis.key_details.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
                <div>
                  <h3>Study order</h3>
                  <ol>{analysis.study_order.map((item) => <li key={item}>{item}</li>)}</ol>
                </div>
                <div>
                  <h3>Next searches</h3>
                  <div className="next-searches">
                    {analysis.next_searches.map((item) => (
                      <button type="button" key={item} onClick={() => useExample(item)}>{item}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>Caveats</h3>
                  <ul>{analysis.caveats.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              </div>
            </section>
          ) : null}

          <div className="results-list">
            {results.map((result) => (
              <article className="result-item" key={result.id}>
                <div className="result-main">
                  <div className="result-heading">
                    <h2>{titleFor(result)}</h2>
                    <span>{secondsLabel(result.start_seconds)}-{secondsLabel(result.end_seconds)}</span>
                  </div>
                  <p className="snippet">{result.text}</p>
                  <div className="meta-line">
                    <span>{result.metadata?.channel_name || result.metadata?.instructor_name || "Unknown source"}</span>
                    <span>{result.metadata?.platform || "video"}</span>
                    <span>rank {Number(result.rank).toFixed(3)}</span>
                  </div>
                </div>
                {result.metadata?.video_url ? (
                  <a className="source-link" href={result.metadata.video_url} target="_blank" rel="noreferrer" aria-label="Open source video">
                    <ExternalLink aria-hidden="true" size={18} />
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="map-view">
          <section className="overview-band">
            <div>
              <p className="section-kicker">Current build</p>
              <h2>Searchable transcript evidence with first-pass semantic search and answers</h2>
              <p>
                The app reads TEST `rag_` tables, retrieves transcript chunks with citations, embeds an initial chunk batch for meaning search, and generates answers only from retrieved sources.
              </p>
            </div>
            <div className="metric-grid" aria-label="Corpus summary">
              <div><strong>12,104</strong><span>chunks</span></div>
              <div><strong>2,298</strong><span>transcripts</span></div>
              <div><strong>2,844</strong><span>techniques</span></div>
              <div><strong>4,352</strong><span>embedded</span></div>
            </div>
          </section>

          <section className="flow-chart" aria-label="RAG pipeline status">
            {pipeline.map((step, index) => {
              const Icon = step.icon;
              return (
                <div className="flow-step" key={step.title}>
                  <div className={`flow-node ${step.status}`}>
                    <Icon aria-hidden="true" size={20} />
                  </div>
                  <div className="flow-copy">
                    <span>{index + 1}</span>
                    <h3>{step.title}</h3>
                    <p>{step.detail}</p>
                    <em>{step.status}</em>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="schema-grid">
            <div className="explain-panel">
              <p className="section-kicker">Embedding vectors</p>
              <h3>Meaning fingerprints for transcript chunks</h3>
              <p className="plain-copy">
                An embedding vector is a long list of numbers created from text. Similar ideas land near each other mathematically, so a search for "stop the pass" can find chunks that say "guard retention" or "recover inside position."
              </p>
            </div>
            <div className="explain-panel">
              <p className="section-kicker">Backfill job</p>
              <h3>What the 4,352 embedded chunks are</h3>
              <p className="plain-copy">
                The job reads `rag_transcript_chunks.text`, sends each chunk to the embedding model, then writes the returned vector into `rag_transcript_chunks.embedding`. 4,352 of 12,104 chunks are embedded right now, so vector search is stronger but still partial.
              </p>
            </div>
          </section>

          <section className="schema-grid">
            <div className="explain-panel">
              <p className="section-kicker">Define it simply</p>
              <h3>RAG = retrieve evidence, then generate from it</h3>
              <p className="plain-copy">
                Instead of asking an AI to answer from memory, RAG first searches your private corpus, pulls back the most relevant source chunks, and uses those chunks as grounded context for the answer.
              </p>
            </div>
            <div className="explain-panel">
              <p className="section-kicker">How people use it</p>
              <h3>Answers backed by your own data</h3>
              <p className="plain-copy">
                Teams use RAG for support bots, internal knowledge search, legal or medical document review, product docs, research assistants, and domain-specific tutoring where citations matter.
              </p>
            </div>
          </section>

          <section className="use-case-panel">
            <div className="table-map-header">
              <p className="section-kicker">Practical ZenCub uses</p>
              <h2>What this is useful for in jiu-jitsu</h2>
            </div>
            <div className="use-case-grid">
              <div>
                <strong>Find the exact clip</strong>
                <span>Search a detail and jump to the timestamp where it is explained.</span>
              </div>
              <div>
                <strong>Compare instruction</strong>
                <span>Find how different channels explain the same position or problem.</span>
              </div>
              <div>
                <strong>Build study stacks</strong>
                <span>Turn search results into focused study lists for a position or problem.</span>
              </div>
              <div>
                <strong>Debug your game</strong>
                <span>Search for the problem you are having and inspect clips that discuss it.</span>
              </div>
            </div>
          </section>

          <section className="pitch-panel">
            <div>
              <p className="section-kicker">How to explain it</p>
              <h2>Ask your jiu-jitsu video library</h2>
              <p>
                ZenCub RAG turns BJJ videos into searchable training evidence. A user asks about a position, technique, or problem, and the system finds the real clips and timestamps behind the answer.
              </p>
            </div>
            <div className="pitch-lines">
              <span>Find the detail.</span>
              <span>Open the source clip.</span>
              <span>Study from cited instruction.</span>
            </div>
          </section>

          <section className="schema-grid">
            <div className="explain-panel">
              <p className="section-kicker">How search works</p>
              <ol>
                <li>The browser sends the query to `/api/rag/search`.</li>
                <li>The API route uses the Supabase service role on the server.</li>
                <li>Supabase runs `search_rag_transcript_chunks` against TEST chunks.</li>
                <li>The UI renders snippets with title, timestamp, source URL, and rank.</li>
              </ol>
            </div>
            <div className="explain-panel">
              <p className="section-kicker">How Ask works</p>
              <ol>
                <li>The API embeds the user's question for semantic retrieval.</li>
                <li>It calls `match_rag_transcript_chunks` against embedded chunks.</li>
                <li>Auto mode mixes vector and text evidence when vector matches are strong.</li>
                <li>It falls back to text if vector matches are weak or citations come back empty.</li>
                <li>The answer model receives only retrieved chunks and returns citations.</li>
              </ol>
            </div>
          </section>

          <section className="example-panel">
            <div className="table-map-header">
              <p className="section-kicker">Evaluated test queries</p>
              <h2>These examples are checked by `npm run eval:queries`</h2>
            </div>
            <div className="eval-strip">
              <div><strong>9/9</strong><span>passing examples</span></div>
              <div><strong>4</strong><span>checks per query</span></div>
              <div><strong>5</strong><span>results inspected</span></div>
              <div><strong>docs/evals</strong><span>latest report</span></div>
            </div>
            <div className="query-grid">
              {ragExamples.map((example) => (
                <button type="button" key={example.query} onClick={() => useExample(example.query)}>
                  <strong>{example.query}</strong>
                  <span>{example.useCase}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="table-map">
            <div className="table-map-header">
              <p className="section-kicker">TEST data map</p>
              <h2>`rag_` tables copied from ZenCub PROD source data</h2>
            </div>
            <div className="table-rows">
              {dataTables.map(([name, count, purpose]) => (
                <div className="table-row" key={name}>
                  <code>{name}</code>
                  <strong>{count}</strong>
                  <span>{purpose}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
