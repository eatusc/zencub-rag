"use client";

import { Brain, Database, ExternalLink, FileText, Loader2, MessageSquare, Search, Workflow } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { ragExamples } from "@/lib/ragExamples";
import type { RagSearchResponse, RagSearchResult } from "@/lib/types";

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
    detail: "The app currently uses Postgres text search to return matching transcript chunks.",
    status: "live",
  },
  {
    icon: Brain,
    title: "Embed for meaning",
    detail: "Next step: write embedding vectors into rag_transcript_chunks.embedding.",
    status: "next",
  },
  {
    icon: MessageSquare,
    title: "Generate answers",
    detail: "Next step: ask an LLM to answer only from retrieved chunks with citations.",
    status: "next",
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
  const [error, setError] = useState<string | null>(null);

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
            <button type="submit" disabled={loading || query.trim().length < 2}>
              {loading ? <Loader2 aria-hidden="true" className="spin" size={18} /> : <Search aria-hidden="true" size={18} />}
              <span>Search</span>
            </button>
          </form>

          <div className="summary-row">
            <span>{resultCountLabel}</span>
            {searchedQuery ? <span>Query: {searchedQuery}</span> : <span>Text search over `rag_transcript_chunks`</span>}
          </div>

          {error ? <div className="error-box">{error}</div> : null}

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
              <h2>Searchable transcript evidence, not full RAG answers yet</h2>
              <p>
                The app reads TEST `rag_` tables, retrieves transcript chunks with citations, and shows the evidence. Embeddings and generated chat answers are the next layer.
              </p>
            </div>
            <div className="metric-grid" aria-label="Corpus summary">
              <div><strong>12,104</strong><span>chunks</span></div>
              <div><strong>2,298</strong><span>transcripts</span></div>
              <div><strong>2,844</strong><span>techniques</span></div>
              <div><strong>0</strong><span>embedded</span></div>
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
              <p className="section-kicker">How a query works today</p>
              <ol>
                <li>The browser sends the query to `/api/rag/search`.</li>
                <li>The API route uses the Supabase service role on the server.</li>
                <li>Supabase runs `search_rag_transcript_chunks` against TEST chunks.</li>
                <li>The UI renders snippets with title, timestamp, source URL, and rank.</li>
              </ol>
            </div>
            <div className="explain-panel">
              <p className="section-kicker">What changes for real RAG</p>
              <ol>
                <li>Backfill embeddings for every transcript chunk.</li>
                <li>Embed the user's question at query time.</li>
                <li>Use vector similarity to retrieve meaning-matched chunks.</li>
                <li>Send those chunks to the LLM and require cited answers.</li>
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
