import { SearchClient } from "@/components/SearchClient";

export default function Home() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ZenCub RAG</p>
          <h1>Transcript Search</h1>
        </div>
        <div className="status-pill">Read-only corpus</div>
      </header>

      <SearchClient />
    </main>
  );
}
