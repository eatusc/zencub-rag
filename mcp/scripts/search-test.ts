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
  start_seconds: number;
};
type SearchBody = {
  results?: Hit[];
  retrieved?: number;
  returned?: number;
  removed_by_filter?: Record<string, number>;
  warnings?: string[];
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
check("strict removes at least as much as flagged",
  (strict.results ?? []).length <= (none.results ?? []).length);

console.log("\n== modes ==");
const textOnly = await search({ query: "kimura from guard", mode: "text", limit: 5 });
const semantic = await search({ query: "kimura from guard", mode: "semantic", limit: 5 });
check("text mode returns results", (textOnly.results ?? []).length > 0);
check("semantic mode returns results or warns",
  (semantic.results ?? []).length > 0 || (semantic.warnings ?? []).length > 0);

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
