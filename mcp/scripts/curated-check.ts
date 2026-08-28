// Show, side by side, what the content_kind gate actually does to real queries.
//
// Not a test: it asserts nothing and is meant to be read. search-test.ts holds
// the assertions. This exists because the gate's value and its cost are both
// judgements about result quality, and a pass/fail count cannot show either.
//
// Spawns its own MCP server so it always runs the code on disk rather than
// whatever a long-lived client connected to earlier.
//
// Run: node --experimental-strip-types mcp/scripts/curated-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = { content?: Array<{ type: string; text?: string }> };
type Hit = { video_title: string | null; content_kind?: string | null; has_technique_cards: boolean };
type Body = {
  results?: Hit[]; retrieved?: number; returned?: number;
  removed_by_filter?: Record<string, number>; unclassified_content_kind?: number;
  retrieval_mode?: string; reranked?: boolean;
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname],
  stderr: "pipe",
});
const client = new Client({ name: "curated-check", version: "0.1.0" });
await client.connect(transport);

async function search(args: Record<string, unknown>): Promise<Body> {
  const r = (await client.callTool({ name: "search_transcripts", arguments: args })) as ToolResult;
  return JSON.parse((r.content ?? []).map((p) => p.text ?? "").join("\n")) as Body;
}

for (const query of ["heel hook defense", "kimura from side control", "escaping side control", "how do I stop gassing out during rolls"]) {
  console.log(`\n================ ${query} ================`);
  for (const filter of ["none", "curated"]) {
    const body = await search({ query, filter, limit: 5 });
    console.log(`\n  filter=${filter}  retrieval=${body.retrieval_mode} reranked=${body.reranked} ` +
      `retrieved=${body.retrieved} returned=${body.returned} unclassified=${body.unclassified_content_kind}`);
    console.log(`  removed: ${JSON.stringify(body.removed_by_filter ?? {})}`);
    (body.results ?? []).forEach((h, i) => {
      console.log(`    ${i + 1}. [${h.content_kind ?? "NULL"}] ${String(h.video_title).slice(0, 62)}`);
    });
  }
}

await client.close();
