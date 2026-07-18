// Server-only: answer generation + provider detection.
// Imports node:child_process (Claude CLI) and openai — never import this from a
// client component. Client-safe types live in "@/lib/providers".
import { execFile } from "node:child_process";
import OpenAI from "openai";
import type { getServerEnv } from "@/lib/env";
import { coerceAnswer, hydrateAnswerCitations, type RagSource } from "@/lib/ragUtils";
import {
  ANSWER_PROVIDERS,
  PROVIDER_META,
  type AnswerProvider,
  type ProviderInfo,
} from "@/lib/providers";
import type { RagAnswer, RagConversationTurn, RagTokenUsage } from "@/lib/types";

type ServerEnv = ReturnType<typeof getServerEnv>;
type GeneratedAnswer = { answer: RagAnswer; usage: RagTokenUsage | null };
export type StructuredGeneration = {
  value: unknown;
  usage: RagTokenUsage | null;
  model: string;
};

function tokenCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function tokenUsage(prompt: unknown, completion: unknown, total?: unknown): RagTokenUsage | null {
  const promptTokens = tokenCount(prompt);
  const completionTokens = tokenCount(completion);
  const totalTokens = tokenCount(total) || promptTokens + completionTokens;
  return totalTokens > 0
    ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }
    : null;
}

const SYSTEM_PROMPT = [
  "You are a concise BJJ research assistant.",
  "Answer only from the provided transcript chunks.",
  "Do not invent techniques, videos, timestamps, or claims.",
  "Each source may include technique, position, difficulty, and gi_nogi tags; use them to frame the answer accurately.",
  "If evidence is weak, say so in caveats.",
  "When conversation history is provided, answer the latest question in light of it without needlessly repeating the earlier answer.",
  "Prior assistant answers are conversation context, not evidence; the provided transcript sources remain the only source of truth.",
  "Write a concise but complete answer for a mobile app, usually 80-140 words.",
  "Lead with the direct answer, then include essential setup, sequence, and a key failure point when the sources support them.",
  "Use short paragraphs and omit filler, repetition, and background that does not help the user apply the answer.",
  "Return valid JSON only with keys: answer, citations, key_takeaways, follow_up_searches, suggested_follow_up, caveats.",
  "key_takeaways, follow_up_searches, and caveats must each be JSON arrays of strings, even when empty; never return a single string for these fields.",
  "Include no more than 3 key_takeaways. Each must add a useful detail instead of repeating the answer.",
  "Include no more than 3 follow_up_searches.",
  "suggested_follow_up must be one natural, specific question that a jiu-jitsu student could ask next based on this answer.",
  "citations must be an array containing 1-3 source id numbers copied from the provided sources, for example [1, 2].",
  "If any source supports the answer, include at least one citation.",
  "Prefer citing 2 or more distinct videos when multiple sources support the answer, rather than repeating one video at different timestamps.",
  "Use short paragraphs and practical jiu-jitsu language.",
].join(" ");

function userContent(query: string, sources: RagSource[], conversation: RagConversationTurn[]): string {
  return JSON.stringify({
    latest_question: query,
    conversation,
    task: conversation.length > 0
      ? "Answer the latest follow-up using the conversation for continuity and only the retrieved transcript chunks as evidence."
      : "Answer the question using only these retrieved transcript chunks.",
    sources,
  });
}

// Local models (and the Claude CLI) sometimes wrap JSON in prose or code fences,
// or prepend a <think> block. Pull out the outermost JSON object.
function extractJson(text: string): unknown {
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : withoutThink).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return {};
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return {};
  }
}

function openAICompatibleClient(provider: AnswerProvider, env: ServerEnv, openaiClient?: OpenAI | null): OpenAI {
  if (provider === "qwen") return new OpenAI({ baseURL: env.ragQwenBaseUrl, apiKey: "ollama" });
  if (provider === "openrouter") {
    return new OpenAI({
      baseURL: env.ragOpenRouterBaseUrl,
      apiKey: env.openRouterApiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/eatusc/zencub-rag",
        "X-Title": "ZenCub RAG",
      },
    });
  }
  return openaiClient ?? new OpenAI({ apiKey: env.openaiApiKey });
}

export async function generateStructuredJson(
  provider: Exclude<AnswerProvider, "claude">,
  systemPrompt: string,
  input: unknown,
  env: ServerEnv,
  options?: { openaiClient?: OpenAI | null; temperature?: number },
): Promise<StructuredGeneration> {
  const model = providerModel(provider, env);
  const client = openAICompatibleClient(provider, env, options?.openaiClient);
  const completion = await client.chat.completions.create({
    model,
    temperature: options?.temperature ?? 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(input) },
    ],
  });
  return {
    value: extractJson(completion.choices[0]?.message.content ?? "{}"),
    usage: tokenUsage(
      completion.usage?.prompt_tokens,
      completion.usage?.completion_tokens,
      completion.usage?.total_tokens,
    ),
    model,
  };
}

async function generateViaOpenAICompatible(
  query: string,
  sources: RagSource[],
  client: OpenAI,
  model: string,
  conversation: RagConversationTurn[],
): Promise<GeneratedAnswer> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent(query, sources, conversation) },
    ],
  });
  const content = completion.choices[0]?.message.content ?? "{}";
  return {
    answer: hydrateAnswerCitations(coerceAnswer(extractJson(content)), sources),
    usage: tokenUsage(
      completion.usage?.prompt_tokens,
      completion.usage?.completion_tokens,
      completion.usage?.total_tokens,
    ),
  };
}

function runClaude(prompt: string, env: ServerEnv): Promise<{ text: string; usage: RagTokenUsage | null }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (env.ragClaudeModel) args.push("--model", env.ragClaudeModel);
    const child = execFile(
      env.ragClaudeBin,
      args,
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Claude CLI failed: ${stderr?.trim() || error.message}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout) as { result?: unknown; usage?: unknown };
          const rawUsage = envelope.usage && typeof envelope.usage === "object"
            ? envelope.usage as Record<string, unknown>
            : {};
          const inputTokens = tokenCount(rawUsage.input_tokens)
            + tokenCount(rawUsage.cache_creation_input_tokens)
            + tokenCount(rawUsage.cache_read_input_tokens);
          resolve({
            text: typeof envelope.result === "string" ? envelope.result : stdout,
            usage: tokenUsage(inputTokens, rawUsage.output_tokens),
          });
        } catch {
          resolve({ text: stdout, usage: null });
        }
      },
    );
    child.stdin?.end(prompt);
  });
}

async function generateViaClaude(
  query: string,
  sources: RagSource[],
  env: ServerEnv,
  conversation: RagConversationTurn[],
): Promise<GeneratedAnswer> {
  const prompt = [
    SYSTEM_PROMPT,
    "",
    "Respond with ONLY the JSON object — no preamble, no explanation, no code fences.",
    "",
    userContent(query, sources, conversation),
  ].join("\n");
  const result = await runClaude(prompt, env);
  return { answer: hydrateAnswerCitations(coerceAnswer(extractJson(result.text)), sources), usage: result.usage };
}

// `openaiClient` is the client the route already built for embeddings/rerank;
// reused for the "openai" provider so we don't construct a second one.
export async function generateAnswer(
  provider: AnswerProvider,
  query: string,
  sources: RagSource[],
  env: ServerEnv,
  openaiClient: OpenAI | null,
  conversation: RagConversationTurn[] = [],
): Promise<GeneratedAnswer> {
  if (provider === "claude") {
    return generateViaClaude(query, sources, env, conversation);
  }
  if (provider === "qwen") {
    const client = openAICompatibleClient(provider, env);
    return generateViaOpenAICompatible(query, sources, client, env.ragQwenModel, conversation);
  }
  if (provider === "openrouter") {
    const client = openAICompatibleClient(provider, env);
    return generateViaOpenAICompatible(query, sources, client, env.ragOpenRouterModel, conversation);
  }
  const client = openaiClient ?? new OpenAI({ apiKey: env.openaiApiKey });
  return generateViaOpenAICompatible(query, sources, client, env.ragAnswerModel, conversation);
}

export function providerModel(provider: AnswerProvider, env: ServerEnv): string {
  if (provider === "qwen") return env.ragQwenModel;
  if (provider === "openrouter") return env.ragOpenRouterModel;
  if (provider === "claude") return env.ragClaudeModel || "claude-cli";
  return env.ragAnswerModel;
}

// Is the local Qwen model actually reachable, with the configured model pulled?
export async function probeQwen(env: ServerEnv): Promise<boolean> {
  try {
    const base = env.ragQwenBaseUrl.replace(/\/v1\/?$/, "");
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ model?: string; name?: string }> };
    const names = (data.models ?? []).map((m) => m.model ?? m.name);
    return names.includes(env.ragQwenModel);
  } catch {
    return false;
  }
}

function probeClaude(env: ServerEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(env.ragClaudeBin, ["--version"], { timeout: 4000 }, (error) => resolve(!error));
  });
}

export async function detectProviders(env: ServerEnv): Promise<ProviderInfo[]> {
  const [qwen, claude] = await Promise.all([probeQwen(env), probeClaude(env)]);
  const available: Record<AnswerProvider, boolean> = {
    qwen,
    openrouter: Boolean(env.openRouterApiKey),
    claude,
    openai: Boolean(env.openaiApiKey),
  };
  return ANSWER_PROVIDERS.map((id) => ({
    id,
    label: PROVIDER_META[id].label,
    model: providerModel(id, env),
    available: available[id],
  }));
}
