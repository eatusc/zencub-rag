import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getServerEnv } from "@/lib/env";

let checkpointer: PostgresSaver | null = null;

export function getLangGraphCheckpointer(): PostgresSaver {
  if (checkpointer) return checkpointer;
  const env = getServerEnv();
  if (!env.langGraphDatabaseUrl) {
    throw new Error("Missing LANGGRAPH_DATABASE_URL. Configure the Supabase session pooler URL.");
  }
  checkpointer = PostgresSaver.fromConnString(env.langGraphDatabaseUrl, {
    schema: env.langGraphCheckpointSchema,
  });
  return checkpointer;
}
