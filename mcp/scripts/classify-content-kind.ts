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
//   --smallest    sample the shortest videos rather than the longest, so an
//                 audit covers the 1-chunk clips and not only livestreams.
//   --reclassify  include videos that already have a content_kind.
//   --verify-excludes
//                 second pass: re-check only videos already labelled with an
//                 excluded kind, using CONTENT_KIND_MODEL, and overwrite the
//                 label when this model disagrees. Run with a different (and
//                 stronger) model than the pass that produced them.
//   --audit-keeps [--sample N] [--seed S] [--kinds a,b]
//                 measure the OTHER direction. --verify-excludes only ever
//                 re-reads what pass 1 wanted to drop, so a wrong KEEP is
//                 unchecked by construction. This takes a reproducible random
//                 sample of the kept-and-never-verified videos, asks the
//                 second model, and reports the false-keep rate with a 95%
//                 upper bound. WRITES NOTHING, deliberately: see the comment
//                 on the audit branch. --kinds restricts the sample to one or
//                 more kept labels, so a small risky class can be measured
//                 densely instead of being represented by the handful of rows
//                 a uniform draw would give it.
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
  "off_topic",
];

// The two values retrieval gates on. Everything else stays searchable, which is
// why the plan keeps the Zahabi back-pain AMAs and the Chewjitsu training talk:
// they are not instruction, and a practitioner still wants them.
const EXCLUDED_KINDS = new Set<ContentKind>(["event_coverage", "no_content", "off_topic"]);

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
// --limit alone always samples the longest videos, which are livestreams and
// seminars. The 1-chunk clips are a different population entirely -- the plan's
// bucket 4 -- and they are where song lyrics and one-line instruction both
// live, so an audit that never sees them proves nothing about them.
const SMALLEST = has("--smallest");
// Second pass. Re-reads only the videos a first pass wants to EXCLUDE and asks
// a different model whether it agrees. A video leaves the corpus only if both
// say so, because a false exclude is the one error no later query can recover
// from; a false keep only costs precision. Measured 2026-08-28: Qwen and Haiku
// agree on the gate 59/60, and the single disagreement was a Qwen false
// exclude, which is exactly what this pass exists to catch.
const VERIFY = has("--verify-excludes");
// The audit of the opposite direction. --verify-excludes is asymmetric by
// design and the asymmetry was never measured: 2,439 of the 2,464 kept videos
// rest on pass 1 alone. This samples them.
const AUDIT = has("--audit-keeps");
const SAMPLE = valueOf("--sample") ? Number(valueOf("--sample")) : 200;
// Sampling is seeded so the same sample can be drawn again and the same rows
// re-read by hand. An unreproducible sample cannot be checked by anyone,
// including whoever ran it.
const SEED = valueOf("--seed") ?? "audit-2026-08-28";
// Restrict the audit to particular kept labels. A uniform draw of 200 over a
// population that is 86% `instruction` gives `interview` about nine rows, and
// interview/event_coverage is the boundary the prompt itself calls the one that
// goes wrong most often. Nine rows cannot say anything about it, so that class
// gets its own pass rather than a token presence in the headline one.
const AUDIT_KINDS = (valueOf("--kinds") ?? "").split(",").map((k) => k.trim()).filter(Boolean);

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

event_coverage - the competition itself is the product: match footage live or edited, commentary over action, highlights, brackets, results shows, rankings and standings shows, event vlogs, behind-the-scenes at a tournament. The takeaway is who won or who is ranked. Being studio-based and conversational does not change this; a rankings show is two people talking and it is still event_coverage.

interview - a PERSON is the through-line, or the sport is being discussed rather than reported: careers, history, profiles, documentaries, news, rules changes, and retrospective analysis of why a fight or match went the way it did.

promotional - the point is to sell or announce: sales, discount codes, seminars, camps, merchandise, giveaways, book launches, event registration.

no_content - there is essentially no intelligible speech to judge. Song lyrics over silent footage, crowd noise, gym ambience, counting, venue PA announcements, [music] markers, untranslated foreign-language announcing. If you cannot tell what the video is about FROM THE TRANSCRIPT, this is the answer, however specific the title is.
off_topic - there IS intelligible speech and it is not about grappling, martial arts, fighting or training at all: finance, cars, travel, other sports, general vlogging. These are submissions nobody ever checked were martial arts. Choose off_topic over no_content whenever someone is genuinely talking and the subject is simply something else.

no_content is about the ABSENCE of speech, never about speech being off-topic, rambling, low quality or uninteresting. If a person is talking in comprehensible sentences it is not no_content: use off_topic when the subject is not grappling, otherwise the class that fits what they are saying.
Badly transcribed speech is still speech. Automatic transcription in this corpus is often mangled -- "I look to the shoulder feeling lif the sweep from the leg" is somebody teaching a sweep. If you can tell what a person is DOING through the garbling, classify that, not the transcription quality. Reserve no_content for transcripts with nothing to interpret at all: song lyrics, [music] markers, applause, crowd noise, counting, venue announcements in another language.

The event_coverage / interview line is the one that goes wrong most often. Do not decide it by whether the event is live, finished or upcoming, and do not decide it merely because a competition is the topic. Ask what the video IS, not what it is about.
- You are watching the competition, or a segment produced around it: match footage live or edited, commentary over action, highlights, and brackets, seeding, results, standings or rankings shows. That is event_coverage, including previews and recaps, and including two hosts in a studio running through who is in and who is out.
- You are watching one person talk about the sport in their own voice: a coach or analyst breaking down styles, weight cuts, striking tendencies, why a fighter tired or why the judges scored it that way; or a profile, career, history or documentary. That is interview, EVEN IF he goes round by round, names scores and says who won, and whether the fight is days away or days past.
A documentary that recounts past champions and an upcoming bracket while following one athlete's life is about that athlete: interview.
The test is whether you are watching the competition, or watching somebody talk about it.
When you are genuinely torn between these two, answer interview.

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

// ── the boilerplate guard ───────────────────────────────────────────────────

// Some transcripts are nothing but a channel tagline and a music marker. They
// are `no_content` by that class's own definition, and asking a model is not
// only unnecessary but actively unreliable: measured 2026-08-28, six of them
// were classified `instruction`, `training_advice` and `promotional` -- all
// KEPT, all retrievable -- because their titles carry a full technique
// description over a two-word transcript ("Use the lasso guard to bait your
// opponent into an omoplata attack..." over the transcript "Let's go!"). The
// prompt warns about exactly this and the model followed the title anyway.
//
// So this one is decided deterministically rather than asked. It is the only
// place in this script that overrides the model, and it can only ever move a
// video INTO no_content, never out of an excluded class into a kept one.
const BOILERPLATE = /Learn from the best on bjjfanatics\.com\.?|\[music\]|\[applause\]|>>|\u266a|\u266b|\ud83c\udfb6/gi;

// Below this many characters of residual speech across the WHOLE transcript,
// there is nothing to teach and nothing to judge. Measured over the corpus:
// 97 videos qualify, 90 of which the model already called no_content, so the
// threshold is not doing the classifier's job for it -- it is catching the
// handful the titles fooled it on.
const BOILERPLATE_MIN_CHARS = 25;

const GUARD_LABEL_SUFFIX = "+boilerplate-guard";

function residualSpeech(chunks: string[]): string {
  return chunks.join(" ").replace(BOILERPLATE, "").replace(/\s+/g, " ").trim();
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

// Ollama's OpenAI-compatible /v1 endpoint cannot turn Qwen3's thinking off.
// Measured 2026-08-28: with max_tokens 200 it spends all 200 on reasoning and
// returns finish_reason "length" with content: "" and the thinking in a
// separate `reasoning` field, so every row fails to parse. `enable_thinking`
// via chat_template_kwargs on /v1 is ignored too. The native /api/chat endpoint
// does honour `think: false`, and returns clean JSON in ~0.6s, so a local run
// uses that transport instead of pretending one API fits both.
const OLLAMA_URL = process.env.CONTENT_KIND_OLLAMA_URL ?? "";

function userMessage(title: string, channel: string, transcript: string): string {
  return `Title: ${title}\nChannel: ${channel}\n\nTRANSCRIPT:\n${transcript || "(empty)"}`;
}

/** Local Ollama, native endpoint, thinking disabled. Returns the raw reply. */
async function askOllama(title: string, channel: string, transcript: string): Promise<string> {
  const response = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 300 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMessage(title, channel, transcript) },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = await response.json() as { message?: { content?: string } };
  return payload.message?.content ?? "";
}

async function classify(title: string, channel: string, transcript: string): Promise<Verdict> {
  if (OLLAMA_URL) return parseVerdict(await askOllama(title, channel, transcript));
  const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // The reply is one small JSON object, ~60 tokens. Left unset, OpenRouter
      // defaults to the model's full output ceiling (64,000 for Haiku 4.5) and
      // then refuses the request unless the key can AFFORD 64,000 output
      // tokens up front. That is a pre-flight affordability check, not
      // consumption, and it is what 402'd this run with $0.31 still on the key
      // ("you requested up to 64000 tokens, but can only afford 63538").
      max_tokens: 200,
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
    const body = (await response.text()).slice(0, 300);
    const error = new Error(`${response.status} ${response.statusText}: ${body}`);
    // 402 (out of credit) and 401 (bad key) are conditions of the run, not of
    // the row. Retrying the next 1,182 videos cannot succeed, and the previous
    // run proved what that costs: a wall of 1,182 identical errors that buried
    // the one fact worth reading. Marked so the loop can stop at the first one.
    if (response.status === 402 || response.status === 401) {
      (error as Error & { fatal?: boolean }).fatal = true;
    }
    throw error;
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return parseVerdict(payload.choices?.[0]?.message?.content ?? "");
}

function parseVerdict(raw: string): Verdict {
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

// Migration 0002 may not be applied yet, and a dry run is part of deciding
// whether to apply it, so the resume predicate cannot be unconditional. Ask the
// catalogue rather than assuming either way: with the column present a real run
// still resumes on content_kind IS NULL, and without it a dry run still works.
const { rows: colRows } = await client.query<{ exists: boolean }>(
  `SELECT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rag_videos'
        AND column_name = 'content_kind'
   ) AS exists`,
);
const hasColumn = colRows[0]?.exists === true;
if (!hasColumn && !DRY_RUN) {
  throw new Error(
    "public.rag_videos.content_kind does not exist. Apply mcp/migrations/0002-content-kind.sql before classifying.",
  );
}
if (!hasColumn) {
  console.log("note: content_kind column not present yet, so this dry run covers every video with chunks.");
}

const goldIds = GOLD.map((item) => item.video_id);
const ALL_KEPT_KINDS = KINDS.filter((kind) => !EXCLUDED_KINDS.has(kind));
for (const kind of AUDIT_KINDS) {
  // An unknown or excluded value here would silently sample nothing and report
  // a clean 0% over zero rows, which is the well-formed-wrong-answer failure
  // this whole codebase keeps running into. Refuse instead.
  if (!(ALL_KEPT_KINDS as string[]).includes(kind)) {
    throw new Error(`--kinds '${kind}' is not a kept content_kind. Valid: ${ALL_KEPT_KINDS.join(", ")}`);
  }
}
const KEPT_KINDS = AUDIT_KINDS.length > 0 ? (AUDIT_KINDS as ContentKind[]) : ALL_KEPT_KINDS;
const { rows } = await client.query<{
  video_id: string; title: string; channel_name: string | null; chunks: string[];
  content_kind?: string | null; chunk_count?: string | null;
}>(
  EVAL
    ? `SELECT v.video_id, v.title, v.channel_name,
              COALESCE(array_agg(c.text ORDER BY c.chunk_index) FILTER (WHERE c.text IS NOT NULL), '{}') AS chunks
         FROM public.rag_videos v
         LEFT JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
        WHERE v.video_id = ANY($1)
        GROUP BY v.video_id, v.title, v.channel_name`
    : AUDIT
    // Reproducible pseudo-random order. md5(id || seed) is uniform over the
    // population and identical on every re-run of the same seed, so the sample
    // can be redrawn and its rows read by hand afterwards. Ordering by
    // random() would make the measurement uncheckable.
    ? `SELECT v.video_id, v.title, v.channel_name, v.content_kind,
              count(c.*)::text AS chunk_count,
              COALESCE(array_agg(c.text ORDER BY c.chunk_index) FILTER (WHERE c.text IS NOT NULL), '{}') AS chunks
         FROM public.rag_videos v
         JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
        WHERE v.content_kind = ANY($1::text[])
          AND v.content_kind_verified_model IS NULL
        GROUP BY v.video_id, v.title, v.channel_name, v.content_kind
        ORDER BY md5(v.video_id || $2::text)
        LIMIT ${Number(SAMPLE)}`
    : VERIFY
    ? `SELECT v.video_id, v.title, v.channel_name,
              COALESCE(array_agg(c.text ORDER BY c.chunk_index) FILTER (WHERE c.text IS NOT NULL), '{}') AS chunks
         FROM public.rag_videos v
         JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
        WHERE v.content_kind = ANY($1::text[])
          AND v.content_kind_verified_model IS NULL
        GROUP BY v.video_id, v.title, v.channel_name
        ORDER BY count(c.*) DESC
        ${LIMIT ? `LIMIT ${Number(LIMIT)}` : ""}`
    : `SELECT v.video_id, v.title, v.channel_name,
              COALESCE(array_agg(c.text ORDER BY c.chunk_index) FILTER (WHERE c.text IS NOT NULL), '{}') AS chunks
         FROM public.rag_videos v
         JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
        WHERE ($1::boolean OR ${hasColumn ? "v.content_kind IS NULL" : "true"})
        GROUP BY v.video_id, v.title, v.channel_name
        ORDER BY count(c.*) ${SMALLEST ? "ASC" : "DESC"}
        ${LIMIT ? `LIMIT ${Number(LIMIT)}` : ""}`,
  // The non-eval branch used to pass an unused $1, which Postgres cannot type,
  // so it failed before issuing a single model call. Found 2026-08-28 on the
  // first real dry run: every prior run of this script was --eval, which takes
  // the other branch, so the classification path had never executed at all.
  EVAL ? [goldIds] : AUDIT ? [KEPT_KINDS, SEED] : VERIFY ? [[...EXCLUDED_KINDS]] : [RECLASSIFY],
);

console.log(`${EVAL ? "EVAL" : AUDIT ? `AUDIT KEEPS (seed ${SEED})` : VERIFY ? "VERIFY EXCLUSIONS" : DRY_RUN ? "DRY RUN" : "CLASSIFY"}: ${rows.length} videos, model=${MODEL}`);

const expectedByid = new Map(GOLD.map((item) => [item.video_id, item]));
let done = 0;
let correct = 0;
let gateFalseExcludes = 0;
const verdicts = new Map<string, Verdict>();
const failures: string[] = [];
const rescued: string[] = [];
const mistakes: string[] = [];
const tally = new Map<string, number>();
// Audit bookkeeping. Kept per row rather than as running totals so the disputed
// videos can be printed with enough to go and read them.
interface Disputed {
  video_id: string; title: string; channel: string;
  was: string; now: ContentKind; confidence: number; why: string; chunks: number;
}
const disputed: Disputed[] = [];
const auditByKind = new Map<string, { n: number; disputed: number }>();
let auditChunks = 0;
let disputedChunks = 0;

let guarded = 0;

for (const row of rows) {
  let verdict: Verdict;
  // Whether THIS row was decided by the guard, so the stored model name says so
  // and the decision is auditable later rather than looking like a model call.
  let guardedRow = false;
  const residual = residualSpeech(row.chunks ?? []);
  if (residual.length < BOILERPLATE_MIN_CHARS) {
    guardedRow = true;
    guarded += 1;
    verdict = {
      kind: "no_content",
      confidence: 1,
      why: `boilerplate guard: ${residual.length} characters of speech remain after stripping taglines and markers (${JSON.stringify(residual.slice(0, 60))})`,
    };
    tally.set(verdict.kind, (tally.get(verdict.kind) ?? 0) + 1);
    verdicts.set(row.video_id, verdict);
    console.log(`  GUARD no_content      ${row.video_id}  ${String(row.title).slice(0, 44)}`);
    console.log(`          ${verdict.why.slice(0, 150)}`);
  } else {
  try {
    verdict = await classify(row.title ?? "", row.channel_name ?? "", sample(row.chunks ?? []));
  } catch (error) {
    // Loud, counted, and non-fatal: one bad row must not throw away the rows
    // already written. The run still exits non-zero at the end.
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${row.video_id}: ${message}`);
    console.log(`  ERR   ${row.video_id} ${String(row.title).slice(0, 50)} -- ${message.slice(0, 120)}`);
    if ((error as Error & { fatal?: boolean }).fatal) {
      console.log(`\nSTOPPING: this is a credential or billing failure, not a bad row. ${done} videos were written and are kept; a re-run resumes on content_kind IS NULL.`);
      break;
    }
    continue;
  }

  tally.set(verdict.kind, (tally.get(verdict.kind) ?? 0) + 1);
  verdicts.set(row.video_id, verdict);
  }

  // Named per row rather than reusing MODEL, so a guarded decision is never
  // mistaken for something the model said.
  const modelLabel = guardedRow ? `${MODEL}${GUARD_LABEL_SUFFIX}` : MODEL;

  if (EVAL) {
    const gold = expectedByid.get(row.video_id);
    const ok = gold?.expected === verdict.kind;
    if (ok) correct += 1;
    else if (gold) {
      mistakes.push(`${row.video_id} "${String(row.title).slice(0, 46)}" expected=${gold.expected} got=${verdict.kind}\n        gold: ${gold.because}\n        model: ${verdict.why}`);
    }
    console.log(`  ${ok ? "OK  " : "MISS"}  ${verdict.kind.padEnd(15)} ${String(row.title).slice(0, 52)}`);
  } else if (AUDIT) {
    // WRITES NOTHING, and that is the point rather than caution. The second
    // model is not a ground truth: on the 35-video gold set Haiku alone scores
    // 34/35 and its own single error is a FALSE EXCLUDE. Overwriting a keep
    // because Haiku disagrees would therefore manufacture exactly the error
    // the two-pass design exists to prevent, and would do it unattended across
    // the whole kept corpus. A disagreement here is a candidate to go and read,
    // not a verdict. So this measures a rate and hands back a list.
    const was = String(row.content_kind ?? "");
    const chunks = Number(row.chunk_count ?? 0);
    const seen = auditByKind.get(was) ?? { n: 0, disputed: 0 };
    seen.n += 1;
    auditChunks += chunks;
    const nowExcluded = EXCLUDED_KINDS.has(verdict.kind);
    if (nowExcluded) {
      seen.disputed += 1;
      disputedChunks += chunks;
      disputed.push({
        video_id: row.video_id,
        title: String(row.title ?? ""),
        channel: String(row.channel_name ?? ""),
        was,
        now: verdict.kind,
        confidence: verdict.confidence,
        why: verdict.why,
        chunks,
      });
    }
    auditByKind.set(was, seen);
    console.log(`  ${nowExcluded ? "DISPUTED" : "agreed  "} ${was.padEnd(15)} -> ${verdict.kind.padEnd(15)} ${chunks}ch  ${row.video_id}  ${String(row.title).slice(0, 44)}`);
    if (nowExcluded) console.log(`           ${verdict.why.slice(0, 170)}`);
  } else if (DRY_RUN) {
    // A dry run that prints only a distribution cannot be audited, and the
    // whole point of one here is to check the exclusions on videos the gold set
    // has never seen. Flag which way each row falls and carry the model's own
    // reason, so a wrong EXCLUDE is visible without a second query.
    const mark = EXCLUDED_KINDS.has(verdict.kind) ? "EXCLUDE" : "keep   ";
    console.log(`  ${mark} ${verdict.kind.padEnd(15)} ${row.video_id}  ${String(row.title).slice(0, 46)}`);
    console.log(`          ${verdict.why.slice(0, 160)}`);
  } else if (VERIFY) {
    // Always stamp the verification, so "checked and agreed" is distinguishable
    // from "never checked". Only overwrite the label when this model disagrees.
    const overturned = !EXCLUDED_KINDS.has(verdict.kind);
    if (overturned) {
      rescued.push(`${row.video_id} "${String(row.title).slice(0, 46)}" -> ${verdict.kind}: ${verdict.why.slice(0, 120)}`);
      await client.query(
        `UPDATE public.rag_videos
            SET content_kind = $2, content_kind_confidence = $3,
                content_kind_model = $4, content_kind_at = now(),
                content_kind_verified_model = $4, content_kind_verified_at = now()
          WHERE video_id = $1`,
        [row.video_id, verdict.kind, verdict.confidence, modelLabel],
      );
    } else {
      await client.query(
        `UPDATE public.rag_videos
            SET content_kind_verified_model = $2, content_kind_verified_at = now()
          WHERE video_id = $1`,
        [row.video_id, modelLabel],
      );
    }
    console.log(`  ${overturned ? "RESCUED" : "agreed  "} ${verdict.kind.padEnd(15)} ${String(row.title).slice(0, 46)}`);
  } else {
    // Committed per video. If this dies at 80%, the 80% is kept and a re-run
    // resumes on content_kind IS NULL.
    await client.query(
      `UPDATE public.rag_videos
          SET content_kind = $2, content_kind_confidence = $3,
              content_kind_model = $4, content_kind_at = now()
        WHERE video_id = $1`,
      [row.video_id, verdict.kind, verdict.confidence, modelLabel],
    );
  }

  done += 1;
  if (!EVAL && done % 25 === 0) console.log(`  ... ${done}/${rows.length}`);
}

// Read before the connection closes: the sample only means something next to
// the population it was drawn from.
let population = 0;
let populationChunks = 0;
if (AUDIT) {
  const { rows: popRows } = await client.query<{ videos: string; chunks: string }>(
    `SELECT count(DISTINCT v.video_id)::text AS videos, count(c.*)::text AS chunks
       FROM public.rag_videos v
       JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id
      WHERE v.content_kind = ANY($1::text[])
        AND v.content_kind_verified_model IS NULL`,
    [KEPT_KINDS],
  );
  population = Number(popRows[0]?.videos ?? 0);
  populationChunks = Number(popRows[0]?.chunks ?? 0);
}

await client.end();

// Wilson score interval, upper bound. Reported instead of the point estimate
// alone because at these rates the point estimate is the uninformative half:
// 0 disputed out of 200 is not "0%", it is "below about 1.9%", and that bound
// is the actual finding.
function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, centre + margin);
}

// Pre-registered before the run, per the rule that a criterion written
// afterwards grades nothing. The title-pattern check this replaces put the
// false-keep population at 5 videos / 7 chunks, roughly 0.2%. A sampled rate
// materially above that is a signal to go and read the disputed rows. The bar
// is deliberately loose because a false keep costs precision only.
//
// It is a flag, NOT a verdict, and the first run proved why. On the `interview`
// stratum it fired at 11.2%, and the largest disputed video was cj0kftppPvM --
// a Zahabi pre-fight breakdown that is in the gold set as a hand-labelled KEEP,
// with the note "Came back event_coverage, which would have deleted it."
// Haiku's own documented error direction is a false EXCLUDE on exactly the
// interview/event_coverage boundary, so pointing it at kept videos inflates
// this rate with its own bias. A high rate here means "read these", never
// "reclassify these".
const AUDIT_BAR = 0.05;
let auditRateOverBar = false;

if (AUDIT) {
  const n = Array.from(auditByKind.values()).reduce((sum, item) => sum + item.n, 0);
  const k = disputed.length;
  const rate = n > 0 ? k / n : 0;
  const upper = wilsonUpper(k, n);
  auditRateOverBar = rate > AUDIT_BAR;

  console.log(`\naudit of the KEEP direction, ${MODEL} over a seeded random sample`);
  console.log(`  population: ${population} kept videos never given a second opinion (${populationChunks} chunks)`);
  console.log(`  sampled:    ${n} videos (${auditChunks} chunks)`);
  console.log(`  disputed:   ${k} -- this model would exclude them (${disputedChunks} chunks)`);
  console.log(`  false-keep rate: ${(100 * rate).toFixed(1)}%, 95% upper bound ${(100 * upper).toFixed(1)}%`);
  console.log(`  implies at most ~${Math.round(upper * population)} misfiled videos in the kept set`);

  console.log("\n  by the label pass 1 gave them:");
  for (const kind of ALL_KEPT_KINDS) {
    const seen = auditByKind.get(kind);
    if (!seen) continue;
    console.log(`    ${kind.padEnd(16)} ${String(seen.disputed).padStart(3)} disputed of ${String(seen.n).padStart(3)} sampled`);
  }

  if (disputed.length > 0) {
    // Sorted by chunk count: a disputed 200-chunk livestream pollutes retrieval
    // far more than a disputed 1-chunk clip, and the count alone hides that.
    console.log("\n  disputed videos, largest first. READ THESE; the second model is not ground truth.");
    for (const item of [...disputed].sort((a, b) => b.chunks - a.chunks)) {
      console.log(`    ${item.video_id}  ${item.chunks}ch  ${item.was} -> ${item.now} (${item.confidence.toFixed(2)})`);
      console.log(`      "${item.title.slice(0, 90)}" -- ${item.channel}`);
      console.log(`      ${item.why.slice(0, 180)}`);
    }
  }
}

if (VERIFY) {
  console.log(`\nverified ${done} exclusions; ${rescued.length} overturned and returned to the corpus:`);
  for (const item of rescued) console.log(`  - ${item}`);
}

if (guarded > 0) {
  console.log(`\n${guarded} video(s) decided by the boilerplate guard rather than the model: nothing but taglines and markers in the transcript.`);
}

console.log("\ndistribution:");
for (const kind of KINDS) console.log(`  ${kind.padEnd(16)} ${tally.get(kind) ?? 0}`);

if (EVAL) {
  console.log(`\ngold set: ${correct}/${rows.length} correct`);

  // Exact-class accuracy is not the number that matters. content_kind drives
  // exactly one decision -- does retrieval keep this video -- and only two of
  // the six values are excluded. A confusion between instruction and interview
  // is invisible to that decision; a confusion between interview and
  // event_coverage silently deletes a video from the corpus. Reporting one
  // headline percentage hides which kind just happened, which is how 24/28
  // read as "nearly there" while two keepers were being thrown away.
  //
  // The two directions are not equally bad, so they are counted separately:
  //   false exclude - gold keeps it, model excludes it. Destroys content.
  //                   Zahabi's back-pain coaching disappears and no query can
  //                   reach it again.
  //   false keep    - gold excludes it, model keeps it. Costs precision only:
  //                   some event chatter stays retrievable, which is the
  //                   status quo today.
  console.log("\ngate (the decision content_kind actually drives):");
  let gateOk = 0;
  const falseExcludes: string[] = [];
  const falseKeeps: string[] = [];
  for (const [id, verdict] of verdicts) {
    const gold = expectedByid.get(id);
    if (!gold) continue;
    const goldExcluded = EXCLUDED_KINDS.has(gold.expected);
    const gotExcluded = EXCLUDED_KINDS.has(verdict.kind);
    if (goldExcluded === gotExcluded) {
      gateOk += 1;
    } else if (goldExcluded) {
      falseKeeps.push(`${id} ${gold.expected} -> ${verdict.kind}`);
    } else {
      falseExcludes.push(`${id} ${gold.expected} -> ${verdict.kind}`);
    }
  }
  console.log(`  keep/exclude correct: ${gateOk}/${rows.length}`);
  console.log(`  false EXCLUDES (destroys content): ${falseExcludes.length}`);
  for (const item of falseExcludes) console.log(`    - ${item}`);
  console.log(`  false keeps (costs precision only): ${falseKeeps.length}`);
  for (const item of falseKeeps) console.log(`    - ${item}`);
  gateFalseExcludes = falseExcludes.length;

  if (mistakes.length > 0) {
    console.log("\nmisses:");
    for (const miss of mistakes) console.log(`  - ${miss}`);
  }
}
if (failures.length > 0) {
  console.log(`\n${failures.length} model/parse failures:`);
  for (const failure of failures.slice(0, 20)) console.log(`  - ${failure}`);
}

// Non-zero on any failure, on a gold score below the bar, and on any false
// exclude. Silence must not be the same signal as success.
const GOLD_BAR = 0.85;
// A false exclude is not a percentage point, it is a video no query can reach
// again. Two of them are exactly why the last run was stopped rather than
// shipped, so the bar is zero rather than a rate. If this cannot be met the
// answer is a better prompt or a narrower gate, not a looser threshold.
const MAX_FALSE_EXCLUDES = 0;

const scored = EVAL && rows.length > 0;
const belowBar = scored && correct / rows.length < GOLD_BAR;
const destructive = scored && gateFalseExcludes > MAX_FALSE_EXCLUDES;

if (auditRateOverBar) {
  console.log(`\nOVER BAR: sampled false-keep rate is above the ${100 * AUDIT_BAR}% set before the run. Read every disputed row above before concluding anything. This model's own errors run toward false EXCLUDES on the interview/event_coverage boundary, so a high rate in a stratum full of that boundary may be measuring the verifier rather than the corpus. Nothing was written.`);
}

if (belowBar) {
  console.log(`\nFAIL: gold accuracy ${(100 * correct / rows.length).toFixed(0)}% is below the ${100 * GOLD_BAR}% bar.`);
}
if (destructive) {
  console.log(`\nFAIL: ${gateFalseExcludes} false exclude(s), bar is ${MAX_FALSE_EXCLUDES}. Each one deletes a video a practitioner should have been able to find. Do not classify the corpus on this prompt.`);
}
process.exit(failures.length > 0 || belowBar || destructive || auditRateOverBar ? 1 : 0);
