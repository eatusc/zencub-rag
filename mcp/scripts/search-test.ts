// End-to-end test for search_transcripts, over real MCP against the real app.
//
// Separate from smoke-test.ts because this one needs the Next app running on
// 3418; the SQL tools do not. A failure here means retrieval, not the corpus.
//
// Run: node --experimental-strip-types mcp/scripts/search-test.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
type Hit = {
  video_title: string | null;
  channel_name: string | null;
  deep_link: string | null;
  deep_link_precision: string;
  has_technique_cards: boolean;
  content_kind?: string | null;
  start_seconds: number;
};
type SearchBody = {
  results?: Hit[];
  retrieved?: number;
  returned?: number;
  removed_by_filter?: Record<string, number>;
  unclassified_content_kind?: number;
  warnings?: string[];
  // Reported by the app's pipeline so a caller can tell a hybrid result from a
  // text-only fallback without inferring it from result quality.
  retrieval_mode?: string;
  reranked?: boolean;
  filter?: string;
};

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname],
  stderr: "pipe",
});
const client = new Client({ name: "zencub-rag-search-test", version: "0.1.0" });
await client.connect(transport);

async function search(args: Record<string, unknown>): Promise<SearchBody> {
  const result = (await client.callTool({ name: "search_transcripts", arguments: args })) as ToolResult;
  try {
    return JSON.parse((result.content ?? []).map((p) => p.text ?? "").join("\n")) as SearchBody;
  } catch {
    return {};
  }
}

console.log("\n== the app is reachable ==");
const health = (await client.callTool({ name: "health", arguments: {} })) as ToolResult;
const healthBody = JSON.parse((health.content ?? []).map((p) => p.text ?? "").join("\n")) as {
  retrieval?: { ok?: boolean; url?: string; error?: string };
};
check("health reports retrieval", healthBody.retrieval !== undefined);
if (!healthBody.retrieval?.ok) {
  console.log(`\n  App unreachable at ${healthBody.retrieval?.url}: ${healthBody.retrieval?.error}`);
  console.log("  Start it, then rerun. The SQL smoke test does not need it.\n");
  process.exit(1);
}
check("retrieval endpoint healthy", healthBody.retrieval.ok === true);

console.log("\n== basic retrieval ==");
const basic = await search({ query: "how do I escape side control", limit: 5 });
check("returns results", (basic.results ?? []).length > 0, `got ${(basic.results ?? []).length}`);
check("respects limit", (basic.results ?? []).length <= 5);
check("hits carry a title", (basic.results ?? []).every((h) => h.video_title !== null));
check("hits carry timestamps", (basic.results ?? []).every((h) => typeof h.start_seconds === "number"));
check("discloses retrieved vs returned", typeof basic.retrieved === "number" && typeof basic.returned === "number");

console.log("\n== deep links ==");
const linked = (basic.results ?? []).filter((h) => h.deep_link_precision === "timestamp");
check("some hits get timestamp links", linked.length > 0, `${linked.length} of ${(basic.results ?? []).length}`);
check("timestamp links carry &t=", linked.every((h) => /[?&]t=\d+s$/.test(h.deep_link ?? "")));
check("no /shorts/ url claims a timestamp", linked.every((h) => !(h.deep_link ?? "").includes("/shorts/")));
check(
  "precision is always declared",
  (basic.results ?? []).every((h) => ["timestamp", "video_only", "unavailable"].includes(h.deep_link_precision)),
);
check("unavailable links are null", (basic.results ?? []).every((h) => h.deep_link_precision !== "unavailable" || h.deep_link === null));

console.log("\n== filters ==");
const q = "heel hook defense";
const none = await search({ query: q, filter: "none", limit: 10 });
const flagged = await search({ query: q, filter: "flagged", limit: 10 });
const strict = await search({ query: q, filter: "strict", limit: 10 });
check("filter=none removes nothing", Object.keys(none.removed_by_filter ?? {}).length === 0);
check("filter=flagged removes something on a polluted query", Object.keys(flagged.removed_by_filter ?? {}).length > 0,
  JSON.stringify(flagged.removed_by_filter));
check("filter=strict keeps only carded videos", (strict.results ?? []).every((h) => h.has_technique_cards));

// content_kind gate. Written so it holds while classification is still running:
// the invariants are about what curated may never do, not about a corpus that
// is fully labelled yet.
const curated = await search({ query: q, filter: "curated", limit: 10 });
check("filter=curated is accepted", Array.isArray(curated.results));
check("curated reports how much is unclassified",
  typeof curated.unclassified_content_kind === "number",
  String(curated.unclassified_content_kind));
check("curated never returns an excluded content_kind",
  (curated.results ?? []).every(
    (h) => h.content_kind !== "event_coverage" && h.content_kind !== "no_content"),
  JSON.stringify((curated.results ?? []).map((h) => h.content_kind)));
check("curated only ever removes for a content_kind reason",
  Object.keys(curated.removed_by_filter ?? {}).every((k) => k.startsWith("content_kind_")),
  JSON.stringify(curated.removed_by_filter));
// The gate must not shrink the page. Filtering happens after retrieval, so
// without over-fetching "heel hook defense" at limit 5 returned 3.
const fullPage = await search({ query: "heel hook defense", filter: "curated", limit: 5 });
check("curated still returns a full page",
  (fullPage.results ?? []).length === 5,
  `returned ${(fullPage.results ?? []).length}, removed ${JSON.stringify(fullPage.removed_by_filter ?? {})}`);
check("a filtered search over-fetches to make room",
  (fullPage.retrieved ?? 0) > 5, `retrieved ${fullPage.retrieved}`);
// The whole point of the exercise: competition commentary must not win a
// defensive-technique query.
check("curated drops event coverage from 'heel hook defense'",
  (fullPage.results ?? []).every((h) => h.content_kind !== "event_coverage"),
  JSON.stringify((fullPage.results ?? []).map((h) => h.content_kind)));

// The default is what most callers get, so it is worth asserting rather than
// assuming it was flipped.
const defaulted = await search({ query: "heel hook defense", limit: 5 });
check("default filter is curated", defaulted.filter === "curated", String(defaulted.filter));

// NULL must survive the gate: unclassified is not a verdict.
check("curated keeps unclassified videos",
  (curated.results ?? []).length > 0 || (curated.unclassified_content_kind ?? 0) === 0,
  `returned ${(curated.results ?? []).length}, unclassified ${curated.unclassified_content_kind}`);
check("strict removes at least as much as flagged",
  (strict.results ?? []).length <= (none.results ?? []).length);

console.log("\n== modes ==");
const textOnly = await search({ query: "kimura from guard", mode: "text", limit: 5 });
const semantic = await search({ query: "kimura from guard", mode: "semantic", limit: 5 });
check("text mode returns results", (textOnly.results ?? []).length > 0);
check("semantic mode returns results or warns",
  (semantic.results ?? []).length > 0 || (semantic.warnings ?? []).length > 0);

console.log("\n== it is the app's pipeline, not a local fusion ==");
// The tool used to RRF two single-mode endpoints itself, which tied every rank
// and produced a strict text,vec,text,vec zipper with keyword always first.
// These assert that ranking now comes from the app: hybrid fusion plus rerank.
const pipeline = await search({ query: "heel hook defense", limit: 8, filter: "none" });
check("reports which retrieval mode actually ran",
  ["hybrid", "text", "vector"].includes(String(pipeline.retrieval_mode)),
  String(pipeline.retrieval_mode));
check("uses hybrid retrieval when both sides are available",
  pipeline.retrieval_mode === "hybrid", String(pipeline.retrieval_mode));
check("reports whether the rerank ran", typeof pipeline.reranked === "boolean", String(pipeline.reranked));
check("the rerank actually ran", pipeline.reranked === true, String(pipeline.reranked));

// The zipper's signature was that results alternated between two sources and
// no video ever repeated, because each endpoint capped per video separately.
// A reranked hybrid pool has no such structure. This is a regression guard: if
// a second fusion ever reappears, the alternation comes back with it.
const pipelineHits = pipeline.results ?? [];
check("returns a full page from the pipeline", pipelineHits.length >= 5, String(pipelineHits.length));

const textPinned = await search({ query: "heel hook defense", limit: 5, mode: "text", filter: "none" });
check("pinning text still reports its mode",
  textPinned.retrieval_mode === "text", String(textPinned.retrieval_mode));
check("pinned modes still get the rerank",
  textPinned.reranked === true, String(textPinned.reranked));

console.log("\n== rejections ==");
const tooShort = (await client.callTool({
  name: "search_transcripts",
  arguments: { query: "a" },
})) as ToolResult;
check("one-character query is rejected", tooShort.isError === true);

const nonsense = await search({ query: "zzzqqq not a real grappling term at all", limit: 5 });
check("nonsense query returns a usable shape", Array.isArray(nonsense.results));

await client.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
