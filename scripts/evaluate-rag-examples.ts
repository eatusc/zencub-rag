import { mkdirSync, writeFileSync } from "node:fs";
import { ragExamples, type RagExample } from "../src/lib/ragExamples.ts";

type SearchResult = {
  video_id: string;
  chunk_index: number;
  start_seconds: number | string | null;
  end_seconds: number | string | null;
  text: string;
  metadata: {
    video_title?: string | null;
    video_url?: string | null;
    citation?: string | null;
    channel_name?: string | null;
    instructor_name?: string | null;
  } | null;
  rank: number;
};

type SearchResponse = {
  query: string;
  results: SearchResult[];
};

type EvalResult = {
  example: RagExample;
  pass: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  topResults: SearchResult[];
};

const baseUrl = process.env.RAG_BASE_URL ?? "http://localhost:3021";
const limit = Number(process.env.RAG_EVAL_LIMIT ?? "5");

function normalize(value: string) {
  return value.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

function searchableText(results: SearchResult[]) {
  return normalize(
    results
      .map((result) => [
        result.text,
        result.metadata?.video_title,
        result.metadata?.citation,
        result.metadata?.channel_name,
        result.metadata?.instructor_name,
      ].filter(Boolean).join(" "))
      .join(" "),
  );
}

function hasAllExpectedTerms(example: RagExample, results: SearchResult[]) {
  const haystack = searchableText(results);
  const missing = example.expectedTerms
    .map((alternatives) => alternatives.filter((term) => haystack.includes(normalize(term))))
    .map((matches, index) => ({ index, matches }))
    .filter((group) => group.matches.length === 0);

  return {
    pass: missing.length === 0,
    detail: missing.length === 0
      ? `matched ${example.expectedTerms.map((group) => group.join(" or ")).join("; ")}`
      : `missing groups: ${missing.map((group) => example.expectedTerms[group.index].join(" or ")).join("; ")}`,
  };
}

function hasCitations(results: SearchResult[]) {
  const checked = results.slice(0, Math.min(3, results.length));
  const missing = checked.filter((result) => !result.metadata?.citation || result.start_seconds == null || result.end_seconds == null);
  return {
    pass: checked.length > 0 && missing.length === 0,
    detail: missing.length === 0 ? `top ${checked.length} have citations/timestamps` : `${missing.length} top results missing citation or timestamp`,
  };
}

function hasSourceUrls(results: SearchResult[]) {
  const checked = results.slice(0, Math.min(3, results.length));
  const missing = checked.filter((result) => !result.metadata?.video_url);
  return {
    pass: checked.length > 0 && missing.length === 0,
    detail: missing.length === 0 ? `top ${checked.length} have source URLs` : `${missing.length} top results missing source URLs`,
  };
}

async function evaluateExample(example: RagExample): Promise<EvalResult> {
  const url = new URL("/api/rag/search", baseUrl);
  url.searchParams.set("q", example.query);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${example.query}: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as SearchResponse;
  const results = payload.results ?? [];
  const termCheck = hasAllExpectedTerms(example, results);
  const citationCheck = hasCitations(results);
  const sourceCheck = hasSourceUrls(results);
  const checks = [
    { name: "minimum results", pass: results.length >= 3, detail: `${results.length} results returned` },
    { name: "expected terms", ...termCheck },
    { name: "citations", ...citationCheck },
    { name: "source URLs", ...sourceCheck },
  ];

  return {
    example,
    pass: checks.every((check) => check.pass),
    checks,
    topResults: results.slice(0, 3),
  };
}

function markdown(results: EvalResult[]) {
  const now = new Date().toISOString();
  const passed = results.filter((result) => result.pass).length;
  const lines = [
    "# RAG Search Eval",
    "",
    `Generated: ${now}`,
    `Base URL: ${baseUrl}`,
    `Result limit: ${limit}`,
    `Passed: ${passed}/${results.length}`,
    "",
    "| Query | Status | Top result | Checks |",
    "| --- | --- | --- | --- |",
  ];

  for (const result of results) {
    const top = result.topResults[0];
    const title = top?.metadata?.video_title ?? top?.video_id ?? "none";
    const checks = result.checks.map((check) => `${check.pass ? "pass" : "fail"} ${check.name}`).join("<br>");
    lines.push(`| \`${result.example.query}\` | ${result.pass ? "PASS" : "FAIL"} | ${escapeTable(title)} | ${checks} |`);
  }

  lines.push("", "## Details", "");
  for (const result of results) {
    lines.push(`### ${result.pass ? "PASS" : "FAIL"}: ${result.example.query}`, "");
    lines.push(`Use case: ${result.example.useCase}`);
    lines.push(`Expected: ${result.example.goodResult}`, "");
    for (const check of result.checks) {
      lines.push(`- ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    lines.push("");
    result.topResults.forEach((top, index) => {
      lines.push(`${index + 1}. ${top.metadata?.video_title ?? top.video_id} @ ${top.start_seconds ?? "?"}-${top.end_seconds ?? "?"}`);
      lines.push(`   - ${top.metadata?.video_url ?? "no source URL"}`);
      lines.push(`   - ${top.text.slice(0, 220).replace(/\s+/g, " ")}${top.text.length > 220 ? "..." : ""}`);
    });
    lines.push("");
  }

  while (lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function escapeTable(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main() {
  const results: EvalResult[] = [];
  for (const example of ragExamples) {
    const result = await evaluateExample(example);
    results.push(result);
    console.log(`${result.pass ? "PASS" : "FAIL"} ${example.query}`);
  }

  mkdirSync("docs/evals", { recursive: true });
  writeFileSync("docs/evals/rag-search-eval.md", markdown(results));
  writeFileSync("docs/evals/rag-search-eval.json", `${JSON.stringify(results, null, 2)}\n`);

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log("wrote docs/evals/rag-search-eval.md");
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
