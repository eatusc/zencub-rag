import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

type ChunkRow = {
  id: string;
  text: string;
};

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    if (line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // env may come from the shell
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const model = process.env.RAG_EMBEDDING_MODEL ?? "text-embedding-3-small";
const batchSize = Number(process.env.RAG_EMBED_BATCH_SIZE ?? "64");
const updateConcurrency = Number(process.env.RAG_EMBED_UPDATE_CONCURRENCY ?? "8");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const apply = process.argv.includes("--apply");
const all = process.argv.includes("--all");
const limit = all ? Number.POSITIVE_INFINITY : Number(limitArg?.split("=")[1] ?? "256");

if (!supabaseUrl || !serviceKey || !openaiKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY");
}

const host = new URL(supabaseUrl).host;
if (!host.includes("YOUR_PROJECT_REF")) {
  throw new Error(`Refusing to embed: expected TEST Supabase, got ${host}`);
}

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const openai = new OpenAI({ apiKey: openaiKey });

async function loadBatch(remaining: number): Promise<ChunkRow[]> {
  const size = Math.min(batchSize, remaining);
  const { data, error } = await supabase
    .from("rag_transcript_chunks")
    .select("id,text")
    .is("embedding", null)
    .order("created_at", { ascending: true })
    .limit(size);

  if (error) throw new Error(error.message);
  return (data ?? []) as ChunkRow[];
}

async function embedBatch(rows: ChunkRow[]) {
  if (!apply) return;

  const response = await openai.embeddings.create({
    model,
    input: rows.map((row) => row.text.replace(/\s+/g, " ").trim().slice(0, 12000)),
  });

  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += updateConcurrency) {
    const group = rows.slice(i, i + updateConcurrency);
    await Promise.all(group.map(async (row, groupIndex) => {
      const index = i + groupIndex;
      const embedding = response.data[index]?.embedding;
      if (!embedding) throw new Error(`Missing embedding for ${row.id}`);
      const { error } = await supabase
        .from("rag_transcript_chunks")
        .update({ embedding, embedded_at: now, embedding_model: model })
        .eq("id", row.id);
      if (error) throw new Error(`update ${row.id}: ${error.message}`);
    }));
  }
}

async function main() {
  console.log(`target: ${host}`);
  console.log(`model: ${model}`);
  console.log(`mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`limit: ${Number.isFinite(limit) ? limit : "all"}`);

  let processed = 0;
  for (;;) {
    const remaining = Number.isFinite(limit) ? Math.max(0, limit - processed) : batchSize;
    if (remaining === 0) break;

    const rows = await loadBatch(remaining);
    if (rows.length === 0) break;

    await embedBatch(rows);
    processed += rows.length;
    console.log(`${apply ? "embedded" : "would embed"} ${processed}`);

    if (!Number.isFinite(limit)) continue;
    if (processed >= limit) break;
  }

  const { count, error } = await supabase
    .from("rag_transcript_chunks")
    .select("id", { count: "exact", head: true })
    .not("embedding", "is", null);
  if (error) throw new Error(error.message);

  console.log(`done: ${processed} ${apply ? "embedded" : "would embed"}; total embedded now ${count ?? 0}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
