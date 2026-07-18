// Pure, dependency-free provider metadata shared by client and server.
// IMPORTANT: keep this file free of any Node-only imports (child_process, openai)
// so the client bundle can import the types/helpers safely.

export type AnswerProvider = "qwen" | "openrouter" | "claude" | "openai";

export const ANSWER_PROVIDERS: AnswerProvider[] = ["qwen", "openrouter", "claude", "openai"];

export type ProviderInfo = {
  id: AnswerProvider;
  label: string;
  model: string;
  available: boolean;
};

export const PROVIDER_META: Record<AnswerProvider, { label: string; blurb: string }> = {
  qwen: { label: "Local Qwen", blurb: "Local model on this machine (Ollama). Private, no API cost." },
  openrouter: { label: "Qwen3 235B", blurb: "Qwen3 235B A22B served through OpenRouter." },
  claude: { label: "Claude", blurb: "Answered by the Claude Code CLI on this machine." },
  openai: { label: "OpenAI", blurb: "OpenAI API (default when no local model is available)." },
};

export function normalizeProvider(value: unknown): AnswerProvider | undefined {
  return value === "qwen" || value === "openrouter" || value === "claude" || value === "openai"
    ? value
    : undefined;
}

// Default order: prefer local Qwen, then the citation-reliable OpenRouter Qwen,
// then OpenAI, then Claude CLI.
export function pickDefaultProvider(providers: ProviderInfo[]): AnswerProvider {
  const available = new Map(providers.map((p) => [p.id, p.available]));
  for (const id of ["qwen", "openrouter", "openai", "claude"] as AnswerProvider[]) {
    if (available.get(id)) return id;
  }
  return "openai";
}
