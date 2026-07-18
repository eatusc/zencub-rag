import nextEnv from "@next/env";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Client } from "pg";

nextEnv.loadEnvConfig(process.cwd());

const connectionString = process.env.LANGGRAPH_DATABASE_URL;
const schema = process.env.LANGGRAPH_CHECKPOINT_SCHEMA ?? "langgraph";

if (!connectionString) {
  throw new Error("Missing LANGGRAPH_DATABASE_URL in the environment or .env.local");
}
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
  throw new Error("LANGGRAPH_CHECKPOINT_SCHEMA must be a simple Postgres identifier");
}

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
} finally {
  await client.end();
}

const checkpointer = PostgresSaver.fromConnString(connectionString, { schema });
try {
  await checkpointer.setup();
  console.log(`LangGraph checkpoint tables are ready in schema ${schema}.`);
} finally {
  await checkpointer.end();
}
