import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";

type SearchResult = {
  id: string;
  video_id: string;
  chunk_index: number;
  start_seconds: number | string | null;
  end_seconds: number | string | null;
  text: string;
  metadata: {
    video_title?: string | null;
    video_url?: string | null;
    channel_name?: string | null;
    instructor_name?: string | null;
    citation?: string | null;
  } | null;
  rank: number;
  similarity?: number;
};

type Source = {
  id: number;
  result_id: string;
  video_id: string;
  title: string;
  citation: string;
  channel: string | null;
  start_seconds: number;
  end_seconds: number;
  source_url: string | null;
  watch_url: string | null;
  score: number;
  text: string;
};

type ModelResult = {
  model: string;
  provider: string | null;
  latency_ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number | null };
  parsed: Record<string, unknown>;
  raw: string;
  checks: {
    valid_json: boolean;
    schema_complete: boolean;
    citation_count: number;
    valid_citations: number;
    invalid_citations: string[];
    has_suggested_follow_up: boolean;
  };
};

const MODELS = (process.env.RAG_EVAL_MODELS
  ?? "qwen/qwen3.5-flash-02-23,qwen/qwen3-32b")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
if (MODELS.length < 2) throw new Error("RAG_EVAL_MODELS must contain at least two models.");
const DEFAULT_QUERIES = [
  "How do I defend a knee cut when my knee shield has already been flattened?",
  "How do I escape side control when they have a deep crossface and my inside elbow is away from my ribs?",
  "How do I finish a rear naked choke when they tuck their chin and use both hands to control my choking wrist?",
];
const QUERIES = process.env.RAG_EVAL_QUERIES
  ? JSON.parse(process.env.RAG_EVAL_QUERIES) as string[]
  : DEFAULT_QUERIES;
if (QUERIES.length === 0 || QUERIES.some((query) => typeof query !== "string" || query.trim().length < 2)) {
  throw new Error("RAG_EVAL_QUERIES must be a JSON array of non-empty query strings.");
}
const BASE_URL = process.env.RAG_EVAL_BASE_URL ?? "http://localhost:3100";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 1) continue;
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  if (!process.env[key]) process.env[key] = value;
}

const openRouterKey = process.env.OPENROUTER_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!openRouterKey || !openaiKey) throw new Error("OPENROUTER_API_KEY and OPENAI_API_KEY are required.");
const openai = new OpenAI({ apiKey: openaiKey });

const SYSTEM_PROMPT = [
  "You are a concise BJJ research assistant.",
  "Answer only from the provided transcript chunks.",
  "Do not invent techniques, videos, timestamps, or claims.",
  "If evidence is weak, say so in caveats.",
  "Return valid JSON only with keys: answer, citations, key_takeaways, follow_up_searches, suggested_follow_up, caveats.",
  "citations must be copied from provided sources and include title, citation, start_seconds, end_seconds, watch_url.",
  "If any source supports the answer, include at least one citation.",
  "Prefer citing 2 or more distinct videos when multiple sources support the answer.",
  "suggested_follow_up must be one natural, specific question based on this answer.",
  "Use short paragraphs and practical jiu-jitsu language.",
].join(" ");

function numeric(value: number | string | null | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampUrl(url: string | null | undefined, startSeconds: number) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) parsed.searchParams.set("t", `${Math.floor(startSeconds)}s`);
    else if (parsed.hostname.includes("youtu.be")) parsed.searchParams.set("t", String(Math.floor(startSeconds)));
    return parsed.toString();
  } catch {
    return url;
  }
}

function rrfFuse(lists: SearchResult[][], k = 60) {
  const scores = new Map<string, number>();
  const rows = new Map<string, SearchResult>();
  for (const list of lists) {
    list.forEach((row, index) => {
      if (!rows.has(row.id)) rows.set(row.id, row);
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...(rows.get(id) as SearchResult), rank: score }));
}

function capPerVideo(rows: SearchResult[], maxPerVideo = 2) {
  const counts = new Map<string, number>();
  return rows.filter((row) => {
    const count = counts.get(row.video_id) ?? 0;
    if (count >= maxPerVideo) return false;
    counts.set(row.video_id, count + 1);
    return row.text.trim().length >= 120;
  });
}

async function retrieve(query: string) {
  const encoded = encodeURIComponent(query);
  const [textResponse, vectorResponse] = await Promise.all([
    fetch(`${BASE_URL}/api/rag/search?q=${encoded}&limit=20`),
    fetch(`${BASE_URL}/api/rag/vector-search?q=${encoded}&limit=20`),
  ]);
  const textPayload = await textResponse.json() as { results?: SearchResult[]; error?: string };
  const vectorPayload = await vectorResponse.json() as { results?: SearchResult[]; error?: string };
  if (!textResponse.ok) throw new Error(textPayload.error ?? "Text retrieval failed");
  if (!vectorResponse.ok) throw new Error(vectorPayload.error ?? "Vector retrieval failed");

  const pool = capPerVideo(rrfFuse([vectorPayload.results ?? [], textPayload.results ?? []])).slice(0, 12);
  const completion = await openai.chat.completions.create({
    model: process.env.RAG_RERANK_MODEL ?? "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Rank transcript chunks by how well they answer the query. Judge intent carefully. Return JSON only: {\"order\": number[]}. Include every index exactly once." },
      { role: "user", content: JSON.stringify({ query, documents: pool.map((row, index) => ({ index, title: row.metadata?.video_title, snippet: row.text.slice(0, 500) })) }) },
    ],
  });
  const order = JSON.parse(completion.choices[0]?.message.content ?? "{}") as { order?: unknown };
  const indices = Array.isArray(order.order) ? order.order.filter((item): item is number => Number.isInteger(item) && item >= 0 && item < pool.length) : [];
  const seen = new Set(indices);
  const ranked = [...indices.map((index) => pool[index]), ...pool.filter((_, index) => !seen.has(index))].slice(0, 8);

  return ranked.map((row, index): Source => {
    const start = numeric(row.start_seconds);
    const end = numeric(row.end_seconds);
    const sourceUrl = row.metadata?.video_url ?? null;
    return {
      id: index + 1,
      result_id: row.id,
      video_id: row.video_id,
      title: row.metadata?.video_title ?? row.video_id,
      citation: row.metadata?.citation ?? `${row.video_id} @ ${Math.floor(start)}`,
      channel: row.metadata?.channel_name ?? row.metadata?.instructor_name ?? null,
      start_seconds: start,
      end_seconds: end,
      source_url: sourceUrl,
      watch_url: timestampUrl(sourceUrl, start),
      score: row.rank ?? 0,
      text: row.text.slice(0, 1400),
    };
  });
}

function extractJson(text: string) {
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : withoutThink).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object returned");
  return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
}

function validate(parsed: Record<string, unknown>, sources: Source[]) {
  const citations = Array.isArray(parsed.citations) ? parsed.citations : [];
  const sourceKeys = new Set(sources.map((source) => JSON.stringify({
    title: source.title,
    citation: source.citation,
    start_seconds: source.start_seconds,
    end_seconds: source.end_seconds,
    watch_url: source.watch_url,
  })));
  const invalidCitations: string[] = [];
  let validCitations = 0;
  for (const item of citations) {
    if (!item || typeof item !== "object") {
      invalidCitations.push("non-object citation");
      continue;
    }
    const citation = item as Record<string, unknown>;
    const key = JSON.stringify({
      title: citation.title,
      citation: citation.citation,
      start_seconds: citation.start_seconds,
      end_seconds: citation.end_seconds,
      watch_url: citation.watch_url,
    });
    if (sourceKeys.has(key)) validCitations += 1;
    else invalidCitations.push(String(citation.citation ?? citation.title ?? "unknown citation"));
  }
  return {
    valid_json: true,
    schema_complete: typeof parsed.answer === "string"
      && Array.isArray(parsed.citations)
      && Array.isArray(parsed.key_takeaways)
      && parsed.key_takeaways.every((item) => typeof item === "string")
      && Array.isArray(parsed.follow_up_searches)
      && parsed.follow_up_searches.every((item) => typeof item === "string")
      && typeof parsed.suggested_follow_up === "string"
      && Array.isArray(parsed.caveats)
      && parsed.caveats.every((item) => typeof item === "string"),
    citation_count: citations.length,
    valid_citations: validCitations,
    invalid_citations: invalidCitations,
    has_suggested_follow_up: typeof parsed.suggested_follow_up === "string" && parsed.suggested_follow_up.trim().endsWith("?"),
  };
}

async function answer(model: string, query: string, sources: Source[]): Promise<ModelResult> {
  const started = performance.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/eatusc/zencub-rag",
      "X-Title": "ZenCub RAG model evaluation",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1_500,
      reasoning: { effort: "none" },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ query, task: "Answer using only these retrieved transcript chunks.", sources }) },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const latencyMs = Math.round(performance.now() - started);
  const payload = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${model}: ${payload.error?.message ?? response.statusText}`);
  const raw = String(payload.choices?.[0]?.message?.content ?? "");
  let parsed: Record<string, unknown> = {};
  let validJson = true;
  try {
    parsed = extractJson(raw);
  } catch {
    validJson = false;
  }
  const checks = validJson
    ? validate(parsed, sources)
    : { valid_json: false, schema_complete: false, citation_count: 0, valid_citations: 0, invalid_citations: [], has_suggested_follow_up: false };
  return {
    model,
    provider: typeof payload.provider === "string" ? payload.provider : null,
    latency_ms: latencyMs,
    usage: {
      prompt_tokens: Number(payload.usage?.prompt_tokens ?? 0),
      completion_tokens: Number(payload.usage?.completion_tokens ?? 0),
      total_tokens: Number(payload.usage?.total_tokens ?? 0),
      cost: payload.usage?.cost == null ? null : Number(payload.usage.cost),
    },
    parsed,
    raw,
    checks,
  };
}

async function judge(query: string, sources: Source[], first: ModelResult, second: ModelResult, orderIndex: number) {
  const firstIsA = orderIndex % 2 === 0;
  const answerA = firstIsA ? first : second;
  const answerB = firstIsA ? second : first;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a strict blind evaluator of citation-grounded Brazilian jiu-jitsu RAG answers.",
          "Use only the supplied sources to judge claims; do not favor verbosity.",
          "Score each answer from 0-5 on groundedness, technical_correctness, practical_utility, completeness, citation_use, and concision.",
          "Return JSON with answer_a, answer_b score objects, winner ('A', 'B', or 'tie'), rationale, factual_issues_a, factual_issues_b.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify({ query, sources, answer_a: answerA.parsed, answer_b: answerB.parsed }) },
    ],
  });
  const parsed = JSON.parse(completion.choices[0]?.message.content ?? "{}") as Record<string, any>;
  const mappedWinner = parsed.winner === "A" ? answerA.model : parsed.winner === "B" ? answerB.model : "tie";
  return { ...parsed, mapped_winner: mappedWinner, order: { A: answerA.model, B: answerB.model } };
}

const cases: Array<{ query: string; sources: Source[]; results: ModelResult[]; judgments: Record<string, any>[] }> = [];
for (let index = 0; index < QUERIES.length; index += 1) {
  const query = QUERIES[index];
  console.error(`Retrieving ${index + 1}/${QUERIES.length}: ${query}`);
  const sources = await retrieve(query);
  const results: ModelResult[] = [];
  for (const model of MODELS) {
    console.error(`  Calling ${model}`);
    results.push(await answer(model, query, sources));
  }
  const judgments: Record<string, any>[] = [];
  for (let candidateIndex = 1; candidateIndex < results.length; candidateIndex += 1) {
    console.error(`  Blind judging baseline vs ${results[candidateIndex].model}`);
    judgments.push(await judge(query, sources, results[0], results[candidateIndex], index + candidateIndex));
  }
  cases.push({ query, sources, results, judgments });
}

function judgmentScore(judgment: Record<string, any>, model: string) {
  const side = judgment.order?.A === model ? judgment.answer_a : judgment.order?.B === model ? judgment.answer_b : null;
  if (!side || typeof side !== "object") return null;
  const values = Object.values(side).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

const summary = Object.fromEntries(MODELS.map((model) => {
  const results = cases.map((item) => item.results.find((result) => result.model === model) as ModelResult);
  const judgments = cases.flatMap((item) => item.judgments).filter((item) => item.order?.A === model || item.order?.B === model);
  const scores = judgments.map((item) => judgmentScore(item, model)).filter((score): score is number => score !== null);
  return [model, {
    mean_latency_ms: Math.round(results.reduce((sum, result) => sum + result.latency_ms, 0) / results.length),
    total_cost: results.reduce((sum, result) => sum + (result.usage.cost ?? 0), 0),
    mean_cost: results.reduce((sum, result) => sum + (result.usage.cost ?? 0), 0) / results.length,
    json_passes: results.filter((result) => result.checks.valid_json && result.checks.schema_complete).length,
    citation_passes: results.filter((result) => result.checks.citation_count > 0 && result.checks.valid_citations === result.checks.citation_count).length,
    follow_up_passes: results.filter((result) => result.checks.has_suggested_follow_up).length,
    judge_wins: judgments.filter((item) => item.mapped_winner === model).length,
    judge_losses: judgments.filter((item) => item.mapped_winner !== model && item.mapped_winner !== "tie").length,
    judge_ties: judgments.filter((item) => item.mapped_winner === "tie").length,
    mean_judge_score_30: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
  }];
}));

const report = {
  generated_at: new Date().toISOString(),
  queries: QUERIES,
  summary,
  cases: cases.map((item) => ({
    query: item.query,
    sources: item.sources.map(({ id, title, citation }) => ({ id, title, citation })),
    results: item.results,
    judgments: item.judgments,
  })),
};
const serialized = JSON.stringify(report, null, 2);
const outputPath = process.env.RAG_EVAL_OUTPUT;
if (outputPath) {
  writeFileSync(outputPath, `${serialized}\n`, "utf8");
  console.log(JSON.stringify({ generated_at: report.generated_at, summary }, null, 2));
} else {
  console.log(serialized);
}
