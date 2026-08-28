// End-to-end smoke test for the ZenCub RAG MCP server.
//
// Speaks real MCP over stdio to a real child process against the real database,
// because "the code looks right" is not evidence that a tool works. Every case
// asserts something specific; the run fails loudly and exits non-zero.
//
// Run: node --experimental-strip-types mcp/scripts/smoke-test.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

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

function bodyOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

function parse(result: ToolResult): Record<string, unknown> {
  try {
    return JSON.parse(bodyOf(result)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname],
  stderr: "pipe",
});

const client = new Client({ name: "zencub-rag-smoke-test", version: "0.1.0" });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

console.log("\n== handshake ==");
const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name).sort();
check("server exposes the expected tools", names.join(",") ===
  "corpus_stats,describe_schema,get_instructor,get_transcript_window,get_video,health,list_techniques,query_sql,search_transcripts",
  names.join(","));
check("every tool has a description", tools.tools.every((tool) => (tool.description ?? "").length > 40));

console.log("\n== health ==");
const health = parse(await call("health"));
check("health reports ok", health.ok === true, JSON.stringify(health));
check("connected as the reader role", health.role === "zencub_mcp_reader", String(health.role));
check("session is read-only", health.read_only === "on", String(health.read_only));

console.log("\n== corpus_stats ==");
const stats = parse(await call("corpus_stats"));
check("chunks counted", Number(stats.chunks_total) > 10_000, String(stats.chunks_total));
check("all chunks embedded", stats.chunks_total === stats.chunks_embedded,
  `${stats.chunks_total} vs ${stats.chunks_embedded}`);
check("videos_with_transcript is below videos_total", Number(stats.videos_with_transcript) < Number(stats.videos_total),
  `${stats.videos_with_transcript} / ${stats.videos_total}`);
check("instructors fewer than creators", Number(stats.instructors_total) < Number(stats.creators_total),
  `${stats.instructors_total} / ${stats.creators_total}`);

console.log("\n== describe_schema ==");
const schema = parse(await call("describe_schema"));
const views = Object.keys((schema.views ?? {}) as Record<string, unknown>).sort();
check("all eight views described", views.length === 8, views.join(","));
check("guidance is present", String(schema.guidance ?? "").includes("v_video_instructors"));
check("no embedding column is exposed", !JSON.stringify(schema.views).includes('"name": "embedding"'));

console.log("\n== query_sql: it works ==");
const counted = parse(await call("query_sql", {
  sql: "select kind, count(*)::int as n from rag_mcp.v_creators group by 1 order by n desc",
}));
check("grouped query returns rows", Number(counted.row_count) >= 2, JSON.stringify(counted.rows));

const capped = parse(await call("query_sql", { sql: "select video_id from rag_mcp.v_videos", limit: 5 }));
check("row limit is applied", Number(capped.row_count) === 5, String(capped.row_count));
check("truncation is disclosed", capped.truncated === true);

console.log("\n== query_sql: it refuses ==");
// A statement that *starts* with a forbidden word is caught by the leader
// check, which fires before the keyword scan, so those cases assert the
// leader-check message. The CTE case is the one that must reach the keyword
// scan, because `WITH` is a legitimate leader and the DELETE hides inside it.
const cases: Array<[string, string, string]> = [
  ["rejects DELETE", "delete from rag_mcp.v_videos", "read-only"],
  ["rejects UPDATE", "update rag_mcp.v_videos set title = 'x'", "read-only"],
  ["rejects DDL", "create table rag_mcp.nope (x int)", "read-only"],
  ["rejects SET", "set statement_timeout = 0", "read-only"],
  ["rejects multi-statement", "select 1; select 2", "one statement"],
  ["rejects data-modifying CTE", "with d as (delete from rag_mcp.v_videos returning 1) select * from d", "DELETE"],
  ["rejects a write hidden after a comment", "/* select */ delete from rag_mcp.v_videos", "read-only"],
  ["rejects UNION onto a forbidden table", "select 1 union select count(*) from public.profiles", "permission denied"],
];
for (const [label, sql, expect] of cases) {
  const result = await call("query_sql", { sql });
  check(label, result.isError === true && bodyOf(result).includes(expect), bodyOf(result).slice(0, 90));
}

// The guard must not be fooled by keywords inside literals or comments, and
// must not reject a legitimate query that merely contains one.
const literal = parse(await call("query_sql", {
  sql: "select count(*)::int as n from rag_mcp.v_chunks where text ilike '%delete the grip%'",
}));
check("keyword inside a string literal is allowed", literal.row_count === 1, JSON.stringify(literal.rows));

console.log("\n== the boundary the guard is not responsible for ==");
// The real protection is the grant, so prove the role cannot reach anything
// outside rag_mcp even with a perfectly well-formed SELECT.
const outside = await call("query_sql", { sql: "select count(*) from public.rag_transcript_chunks" });
check("cannot read raw corpus tables", outside.isError === true && /permission denied/i.test(bodyOf(outside)),
  bodyOf(outside).slice(0, 90));

console.log("\n== get_instructor ==");
const danaher = parse(await call("get_instructor", { name: "Danaher" }));
const instructor = (danaher.instructor ?? {}) as Record<string, unknown>;
check("instructor found by name", String(instructor.display_name ?? "").includes("Danaher"), JSON.stringify(instructor));
check("instructor has attributed videos", Array.isArray(danaher.videos) && (danaher.videos as unknown[]).length > 0);
check("coverage breakdown returned", Array.isArray(danaher.coverage));

const channel = await call("get_instructor", { name: "BJJ Fanatics" });
check("a channel is not returned as an instructor",
  channel.isError === true || !String(bodyOf(channel)).includes('"kind": "channel"'),
  bodyOf(channel).slice(0, 90));

console.log("\n== get_video and get_transcript_window ==");
const oneVideo = parse(await call("query_sql", {
  sql: "select video_id from rag_mcp.v_videos where has_transcript order by chunk_count desc",
  limit: 1,
}));
const videoId = String(((oneVideo.rows as Array<Record<string, unknown>>)[0] ?? {}).video_id);
check("found a video to probe", videoId.length > 0, videoId);

const video = parse(await call("get_video", { video_id: videoId }));
check("video row returned", Boolean((video.video as Record<string, unknown>)?.title), JSON.stringify(video.video ?? {}).slice(0, 90));
check("instructors attached", Array.isArray(video.instructors));
check("techniques attached", Array.isArray(video.techniques));

const window = parse(await call("get_transcript_window", { video_id: videoId, start_seconds: 60, end_seconds: 240 }));
check("transcript window returns text", String(window.transcript ?? "").length > 200, String(window.chunk_count));
check("window reports its actual bounds", Boolean(window.actual_window));

const tooWide = await call("get_transcript_window", { video_id: videoId, start_seconds: 0, end_seconds: 99_999 });
check("over-wide window is refused", tooWide.isError === true, bodyOf(tooWide).slice(0, 60));

console.log("\n== list_techniques ==");
const guardTechniques = parse(await call("list_techniques", { position: "guard", limit: 10 }));
check("filtered techniques returned", Number(guardTechniques.row_count) > 0, String(guardTechniques.row_count));

console.log("\n== filter validation: the well-formed wrong answer ==");
// The defining failure this section exists for: list_techniques(gi_nogi:"nogi")
// used to return 0 rows with truncated:false while the real answer was 28, and
// list_techniques(gi_nogi:"gi") used to return no_gi cards because the match
// was a substring and 'no_gi' ILIKE '%gi%'. Both are asserted against here.

const noGiUnderscore = parse(await call("list_techniques", { gi_nogi: "no_gi", limit: 200 }));
check("no_gi returns rows", Number(noGiUnderscore.row_count) > 0, String(noGiUnderscore.row_count));

for (const spelling of ["nogi", "no-gi", "No Gi", "NO_GI"]) {
  const variant = parse(await call("list_techniques", { gi_nogi: spelling, limit: 200 }));
  check(`gi_nogi '${spelling}' resolves to no_gi`,
    Number(variant.row_count) === Number(noGiUnderscore.row_count),
    `${variant.row_count} vs ${noGiUnderscore.row_count}`);
}

const giOnly = parse(await call("list_techniques", { gi_nogi: "gi", limit: 200 }));
const giRows = (giOnly.rows ?? []) as Array<Record<string, unknown>>;
check("gi returns rows", giRows.length > 0, String(giOnly.row_count));
check("gi never returns a no_gi card", giRows.every((row) => row.gi_nogi === "gi"),
  [...new Set(giRows.map((row) => String(row.gi_nogi)))].join(","));
check("gi and no_gi are disjoint result sets",
  Number(giOnly.row_count) !== Number(noGiUnderscore.row_count) ||
    giRows.every((row) => row.gi_nogi === "gi"));

const badGiNogi = await call("list_techniques", { gi_nogi: "kimono" });
check("unknown gi_nogi is refused, not answered", badGiNogi.isError === true, bodyOf(badGiNogi).slice(0, 80));
check("refusal names the valid values",
  bodyOf(badGiNogi).includes("no_gi") && bodyOf(badGiNogi).includes("both"),
  bodyOf(badGiNogi).slice(0, 140));

const badType = await call("list_techniques", { type: "submissions" });
check("unknown type is refused", badType.isError === true, bodyOf(badType).slice(0, 80));
check("type refusal lists real types", bodyOf(badType).includes("submission ("), bodyOf(badType).slice(0, 140));

const badDifficulty = await call("list_techniques", { difficulty: "beginner" });
check("unknown difficulty is refused", badDifficulty.isError === true, bodyOf(badDifficulty).slice(0, 80));
check("difficulty refusal names fundamental", bodyOf(badDifficulty).includes("fundamental"), bodyOf(badDifficulty).slice(0, 140));

const badPosition = await call("list_techniques", { position: "trampoline" });
check("unknown position is refused", badPosition.isError === true, bodyOf(badPosition).slice(0, 80));

const badInstructor = await call("list_techniques", { instructor: "not-a-real-slug" });
check("unknown instructor slug is refused", badInstructor.isError === true, bodyOf(badInstructor).slice(0, 80));
check("instructor refusal distinguishes slug from empty result",
  bodyOf(badInstructor).includes("does not exist"), bodyOf(badInstructor).slice(0, 160));

check("applied filters are reported back",
  Boolean((guardTechniques.filters_applied as Record<string, unknown>)?.position),
  JSON.stringify(guardTechniques.filters_applied ?? {}).slice(0, 120));

const exactType = parse(await call("list_techniques", { type: "guard_retention", limit: 200 }));
const exactTypeRows = (exactType.rows ?? []) as Array<Record<string, unknown>>;
check("exact type match does not leak neighbours",
  exactTypeRows.length > 0 && exactTypeRows.every((row) => row.type === "guard_retention"),
  [...new Set(exactTypeRows.map((row) => String(row.type)))].join(","));

await client.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
