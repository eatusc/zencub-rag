"use client";

import { ExternalLink, Loader2, Search } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
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

export function SearchClient() {
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

  return (
    <section className="workspace">
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
    </section>
  );
}
