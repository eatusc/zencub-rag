// Classify every corpus video into a content_kind, so retrieval can gate on
// what a video *is* rather than on two signals that answer other questions.
//
// Why this exists is recorded in mcp/migrations/0002-content-kind.sql and
// mcp/PLAN.md. In one line: martial_arts_relevance answers "is there a
// technique to extract" and is NULL for 150 videos it never ran on;
// technique_count answers "did extraction succeed". Neither answers "should a
// practitioner see this".
//
// Run:
//   node --experimental-strip-types mcp/scripts/classify-content-kind.ts --eval
//   node --experimental-strip-types mcp/scripts/classify-content-kind.ts --limit 50
//   node --experimental-strip-types mcp/scripts/classify-content-kind.ts
//
// Modes:
//   --eval        classify only the hand-labelled gold set and score against
//                 it. Writes nothing. Run this first, and after any prompt
//                 change: a classifier is not trusted because it says it is.
//   --dry-run     classify but do not write.
//   --limit N     stop after N videos.
//   --reclassify  include videos that already have a content_kind.
//
// Writes go through LANGGRAPH_DATABASE_URL, the owner connection, because the
// MCP reader role has SELECT and nothing else and must keep it that way. This
// script is therefore NOT part of the MCP server and is never imported by it.

import { Client } from "pg";
import { readFileSync } from "node:fs";
import { GOLD, type ContentKind } from "./gold-content-kind.ts";

const KINDS: ContentKind[] = [
  "instruction",
  "training_advice",
  "event_coverage",
  "interview",
  "promotional",
  "no_content",
];

// ── env ─────────────────────────────────────────────────────────────────────

function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    let body: string;
    try {
      body = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. This script needs it; it will not guess.`);
  return value;
}

// Called here, not in main, because the module-level consts below read
// process.env at evaluation time and top-level consts evaluate in source order.
// With the call further down, only variables already exported into the shell
// were visible and everything from .env.local silently read as empty -- which
// surfaced as an OpenRouter 401 rather than as a missing-config error.
loadEnv();

// ── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const EVAL = has("--eval");
const DRY_RUN = has("--dry-run") || EVAL;
const RECLASSIFY = has("--reclassify");
const LIMIT = valueOf("--limit") ? Number(valueOf("--limit")) : undefined;

// ── the prompt ──────────────────────────────────────────────────────────────

// Deliberately describes each class by what its transcript sounds like, not by
// what its title suggests. The corpus contains "Guard Passing Drills" whose
// transcript is "I love you. I love you." and "Beginners Guide To Inside
// Camping" that the pipeline rejected as not martial arts. A classifier
// steered by the title reproduces both mistakes.
const SYSTEM = `You classify Brazilian jiu-jitsu / grappling / MMA videos by what their TRANSCRIPT contains, for a search corpus used by practitioners.

Judge ONLY the transcript text. The title is given for context and is frequently misleading in this corpus: some titles promise a technique over a transcript that is entirely song lyrics, and some vague titles sit over real instruction.

Exactly one of:

instruction - someone explains or demonstrates how to do something: a technique, a drill, a concept, a position, strength/mobility/physical prep, striking mechanics. Second-person coaching language, body-part sequencing, "you want to", "put your hand here". Rolling commentary counts if it explains what is happening and why.

training_advice - practitioner-facing but not a technique: injury, recovery, longevity, mindset, motivation, competition nerves, belt progression, gym culture, coaching, training partners, career, health, safety. "My back hurts from training" is answered here.

event_coverage - match footage, competition commentary, highlights, brackets, results, rankings, event vlogs, behind-the-scenes at a tournament. Play-by-play with names and scores. Says who won, not how to do it.

interview - conversation ABOUT the sport with a person: history, careers, profiles, news, rules changes, MMA fight analysis. Discussion, not teaching, not live play-by-play.

promotional - the point is to sell or announce: sales, discount codes, seminars, camps, merchandise, giveaways, book launches, event registration.

no_content - the transcript carries essentially no speech about the subject. Song lyrics over silent footage, crowd noise, gym ambience, counting, venue PA announcements, [music] markers, untranslated foreign-language announcing. If you cannot tell what the video is about FROM THE TRANSCRIPT, this is the answer, however specific the title is.

Reply with JSON only: {"kind":"<one value>","confidence":<0-1>,"why":"<one short sentence quoting the transcript>"}`;

// ── transcript sampling ─────────────────────────────────────────────────────

/**
 * Sample across the whole video, not the first N chunks.
 *
 * Intros lie in both directions: instructional videos open with music and
 * channel boilerplate, and event coverage opens with a coherent-sounding
 * preamble. Taking the head only would classify on the part least
 * representative of the body.
 */
function sample(chunks: string[], budget = 6_000): string {
  if (chunks.length === 0) return "";
  const wanted = Math.min(chunks.length, 8);
  const picked: string[] = [];
  for (let i = 0; i < wanted; i += 1) {
    const index = Math.round((i * (chunks.length - 1)) / Math.max(wanted - 1, 1));
    const chunk = chunks[index];
    if (chunk && !picked.includes(chunk)) picked.push(chunk);
  }
  let out = picked.join("\n---\n");
  if (out.length > budget) out = out.slice(0, budget);
  return out;
}

// ── the model call ──────────────────────────────────────────────────────────

interface Verdict {
  kind: ContentKind;
  confidence: number;
  why: string;
}

const BASE_URL = process.env.CONTENT_KIND_BASE_URL
  ?? process.env.RAG_OPENROUTER_BASE_URL
  ?? "https://openrouter.ai/api/v1";
const MODEL = process.env.CONTENT_KIND_MODEL ?? process.env.RAG_OPENROUTER_MODEL ?? "";
const API_KEY = process.env.CONTENT_KIND_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";

async function classify(title: string, channel: string, transcript: string): Promise<Verdict> {
  const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Title: ${title}\nChannel: ${channel}\n\nTRANSCRIPT:\n${transcript || "(empty)"}`,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content ?? "";
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) throw new Error(`No JSON in model reply: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]) as Partial<Verdict>;
  // A value outside the enum is a failure, not something to coerce to a
  // neighbour. Coercing is how a wrong label becomes an invisible one.
  if (!parsed.kind || !KINDS.includes(parsed.kind)) {
    throw new Error(`Model returned kind='${String(parsed.kind)}', which is not one of ${KINDS.join(", ")}`);
  }
  return {
    kind: parsed.kind,
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    why: String(parsed.why ?? "").slice(0, 400),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

if (!MODEL) {
  throw new Error("Set CONTENT_KIND_MODEL (or RAG_OPENROUTER_MODEL). This script will not pick a model for you.");
}

const dsn = required("LANGGRAPH_DATABASE_URL");
const expectedRef = required("RAG_TEST_PROJECT_REF");
// Same assertion the MCP server makes at boot. Production is never a target of
// this repository, and a classification pass is a write.
if (!dsn.includes(expectedRef)) {
  throw new Error("LANGGRAPH_DATABASE_URL does not point at RAG_TEST_PROJECT_REF. Refusing to run.");
}

const client = new Client({ connectionString: dsn });
await client.connect();

const goldIds = GOLD.map((item) => item.video_id);
const { rows } = await client.query<{
  video_id: string; title: string; channel_name: string | null; chunks: string[];
}>(
  EVAL
    ? `SELECT v.video_id, v.title, v.channel_name,
              COALESCE(array_agg(c.text ORDER BY c.chunk_index) FILTER (WHERE c.text IS NOT NULL), '{}') AS chunks
         FROM public.rag_videos v
         LEFT JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
        WHERE v.video_id = ANY($1)
        GROUP BY v.video_id, v.title, v.channel_name`
    : `SELECT v.video_id, v.title, v.channel_name,
              COALESCE(array_agg(c.text ORDER BY c.chunk_index) FILTER (WHERE c.text IS NOT NULL), '{}') AS chunks
         FROM public.rag_videos v
         JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
        WHERE ($2::boolean OR v.content_kind IS NULL)
        GROUP BY v.video_id, v.title, v.channel_name
        ORDER BY count(c.*) DESC
        ${LIMIT ? `LIMIT ${Number(LIMIT)}` : ""}`,
  EVAL ? [goldIds] : [null, RECLASSIFY],
);

console.log(`${EVAL ? "EVAL" : DRY_RUN ? "DRY RUN" : "CLASSIFY"}: ${rows.length} videos, model=${MODEL}`);

const expectedByid = new Map(GOLD.map((item) => [item.video_id, item]));
let done = 0;
let correct = 0;
const failures: string[] = [];
const mistakes: string[] = [];
const tally = new Map<string, number>();

for (const row of rows) {
  let verdict: Verdict;
  try {
    verdict = await classify(row.title ?? "", row.channel_name ?? "", sample(row.chunks ?? []));
  } catch (error) {
    // Loud, counted, and non-fatal: one bad row must not throw away the rows
    // already written. The run still exits non-zero at the end.
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${row.video_id}: ${message}`);
    console.log(`  ERR   ${row.video_id} ${String(row.title).slice(0, 50)} -- ${message.slice(0, 120)}`);
    continue;
  }

  tally.set(verdict.kind, (tally.get(verdict.kind) ?? 0) + 1);

  if (EVAL) {
    const gold = expectedByid.get(row.video_id);
    const ok = gold?.expected === verdict.kind;
    if (ok) correct += 1;
    else if (gold) {
      mistakes.push(`${row.video_id} "${String(row.title).slice(0, 46)}" expected=${gold.expected} got=${verdict.kind}\n        gold: ${gold.because}\n        model: ${verdict.why}`);
    }
    console.log(`  ${ok ? "OK  " : "MISS"}  ${verdict.kind.padEnd(15)} ${String(row.title).slice(0, 52)}`);
  } else if (!DRY_RUN) {
    // Committed per video. If this dies at 80%, the 80% is kept and a re-run
    // resumes on content_kind IS NULL.
    await client.query(
      `UPDATE public.rag_videos
          SET content_kind = $2, content_kind_confidence = $3,
              content_kind_model = $4, content_kind_at = now()
        WHERE video_id = $1`,
      [row.video_id, verdict.kind, verdict.confidence, MODEL],
    );
  }

  done += 1;
  if (!EVAL && done % 25 === 0) console.log(`  ... ${done}/${rows.length}`);
}

await client.end();

console.log("\ndistribution:");
for (const kind of KINDS) console.log(`  ${kind.padEnd(16)} ${tally.get(kind) ?? 0}`);

if (EVAL) {
  console.log(`\ngold set: ${correct}/${rows.length} correct`);
  if (mistakes.length > 0) {
    console.log("\nmisses:");
    for (const miss of mistakes) console.log(`  - ${miss}`);
  }
}
if (failures.length > 0) {
  console.log(`\n${failures.length} model/parse failures:`);
  for (const failure of failures.slice(0, 20)) console.log(`  - ${failure}`);
}

// Non-zero on any failure, and on a gold score below the bar. Silence must not
// be the same signal as success.
const GOLD_BAR = 0.85;
const failed = failures.length > 0 || (EVAL && rows.length > 0 && correct / rows.length < GOLD_BAR);
if (EVAL && rows.length > 0 && correct / rows.length < GOLD_BAR) {
  console.log(`\nFAIL: gold accuracy ${(100 * correct / rows.length).toFixed(0)}% is below the ${100 * GOLD_BAR}% bar.`);
}
process.exit(failed ? 1 : 0);
