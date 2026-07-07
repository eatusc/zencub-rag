type ServerEnv = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey?: string;
  ragAnalyzeModel: string;
  ragAnswerModel: string;
  ragEmbeddingModel: string;
  ragRerankModel: string;
  ragRerankEnabled: boolean;
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
    ragAnalyzeModel: process.env.RAG_ANALYZE_MODEL ?? "gpt-4o-mini",
    ragAnswerModel: process.env.RAG_ANSWER_MODEL ?? "gpt-4o-mini",
    ragEmbeddingModel: process.env.RAG_EMBEDDING_MODEL ?? "text-embedding-3-small",
    ragRerankModel: process.env.RAG_RERANK_MODEL ?? process.env.RAG_ANALYZE_MODEL ?? "gpt-4o-mini",
    ragRerankEnabled: process.env.RAG_RERANK !== "off",
  };
}
