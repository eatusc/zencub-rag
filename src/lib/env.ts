type ServerEnv = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey?: string;
  openRouterApiKey?: string;
  ragAnalyzeModel: string;
  ragAnswerModel: string;
  ragEmbeddingModel: string;
  ragRerankModel: string;
  ragRerankEnabled: boolean;
  ragQwenBaseUrl: string;
  ragQwenModel: string;
  ragOpenRouterBaseUrl: string;
  ragOpenRouterModel: string;
  ragClaudeBin: string;
  ragClaudeModel: string;
};

export function getServerEnv(): ServerEnv {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }

  if (!supabaseServiceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    ragAnalyzeModel: process.env.RAG_ANALYZE_MODEL ?? "gpt-4o-mini",
    ragAnswerModel: process.env.RAG_ANSWER_MODEL ?? "gpt-4o-mini",
    ragEmbeddingModel: process.env.RAG_EMBEDDING_MODEL ?? "text-embedding-3-small",
    ragRerankModel: process.env.RAG_RERANK_MODEL ?? process.env.RAG_ANALYZE_MODEL ?? "gpt-4o-mini",
    ragRerankEnabled: process.env.RAG_RERANK !== "off",
    // Local Qwen served by Ollama's OpenAI-compatible endpoint on the Mac Studio.
    ragQwenBaseUrl: process.env.RAG_QWEN_BASE_URL ?? "http://localhost:11434/v1",
    ragQwenModel: process.env.RAG_QWEN_MODEL ?? "qwen3.6:35b-mlx",
    ragOpenRouterBaseUrl: process.env.RAG_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    ragOpenRouterModel: process.env.RAG_OPENROUTER_MODEL ?? "qwen/qwen3-235b-a22b-2507",
    // Claude Code CLI. Empty model => CLI's own default.
    ragClaudeBin: process.env.RAG_CLAUDE_BIN ?? "claude",
    ragClaudeModel: process.env.RAG_CLAUDE_MODEL ?? "",
  };
}
