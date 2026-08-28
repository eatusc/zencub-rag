#!/usr/bin/env node
// ZenCub RAG MCP server (Phase 1: structured tools, pure SQL).
//
// Answers questions about the BJJ corpus by querying it, rather than letting a
// model guess from what it remembers. Two kinds of question need two different
// mechanisms, and this phase covers the second:
//
//   - content questions ("what does X say about the knee cut") need retrieval,
//     which arrives in Phase 2 on top of the app's existing hybrid pipeline
//   - analytical questions ("how many videos per instructor", "which positions
//     are thin") need SQL, because no amount of chunk retrieval counts anything
//
// Deliberately no answer-generation tool. The MCP client is already a model;
// this returns evidence and lets it do the synthesis.
//
// Run: node --experimental-strip-types mcp/src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CorpusDatabase, loadConfig, loadEnv, type QueryResult } from "./db.ts";
import { guardSql, withRowLimit } from "./sqlGuard.ts";
import { deepLink, retrievalBaseUrl, retrieve, type RetrievalHit } from "./search.ts";
import { stitchTranscript } from "./transcript.ts";
import { FilterVocabulary } from "./enums.ts";

loadEnv();
const config = loadConfig();
const db = new CorpusDatabase(config);
const vocabulary = new FilterVocabulary(db);

const server = new McpServer({ name: "zencub-rag", version: "0.1.0" });

// ── output helpers ──────────────────────────────────────────────────────────

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function failure(message: string) {
  return { ...text(message), isError: true as const };
}

/**
 * Turn a thrown error into something the calling model can act on.
 *
 * Postgres messages are genuinely useful here (a column that does not exist, a
 * statement timeout), so they pass through. This server reads a curated view
 * schema with no private data in it, so there is nothing in a message worth
 * hiding, unlike the app's own routes which deliberately redact.
 */
function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    if (message.includes("statement timeout") || message.includes("canceling statement")) {
      return `Query exceeded the ${config.statementTimeoutMs}ms statement timeout. Narrow it, add a WHERE clause, or aggregate rather than listing rows.`;
    }
    return message;
  }
  return "Unknown error.";
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return config.defaultRowLimit;
  return Math.min(Math.max(Math.trunc(requested), 1), config.maxRowLimit);
}

function resultPayload(result: QueryResult, limit: number) {
  return {
    row_count: result.rowCount,
    // A caller cannot tell a complete answer from a clipped one otherwise, and
    // silently clipped results are how a model reports "there are 200 videos"
    // when there are three thousand.
    truncated: result.rowCount >= limit,
    ...(result.rowCount >= limit ? { note: `Result was capped at ${limit} rows. Aggregate, filter, or raise the limit.` } : {}),
    columns: result.columns,
    rows: result.rows,
  };
}

// ── schema description ──────────────────────────────────────────────────────

const GUIDANCE = `
HOW TO ANSWER QUESTIONS ABOUT THIS CORPUS

Everything lives in schema rag_mcp, which is read-only. Query it with query_sql.

Pick the right view, because the obvious question has several defensible answers:
  - "how many videos" -> v_videos has one row per video, but only rows with
    has_transcript = true are actually searchable. Say which one you counted.
  - "which instructors" -> v_instructors is people only. v_creators also holds
    channels and publishers. Never present a channel as a human instructor.
  - "who teaches what" -> v_video_instructors already joins attribution across
    the uuid/text boundary. Do not join v_videos to attribution yourself.

Two traps this schema exists to prevent:
  1. Attribution keys on an internal uuid while chunks and techniques key on the
     external text video_id. v_video_instructors resolves this; use it.
  2. Only creators whose effective kind is 'person' may be shown as instructors.
     v_instructors already filters to those, and excludes opt-outs.

For "what does someone SAY about X", do not LIKE over v_chunks.text. That is
keyword matching over transcript fragments and it will miss most of the corpus.
Semantic retrieval arrives as a separate tool; until then, say that a text
search is what you did.

The embedding vector is not exposed. Rows carry an 'embedded' boolean instead.

These figures describe the corpus as of corpus_synced_at in v_corpus_stats, not
live production.
`.trim();

// ── tools ───────────────────────────────────────────────────────────────────

server.registerTool(
  "describe_schema",
  {
    title: "Describe the corpus schema",
    description:
      "Return every queryable view, its columns and types, and guidance on which view answers which kind of question. Call this before writing SQL against the corpus.",
    inputSchema: {},
  },
  async () => {
    try {
      const columns = await db.readOnly(`
        SELECT c.relname AS view_name,
               a.attname AS column_name,
               format_type(a.atttypid, a.atttypmod) AS data_type,
               col_description(c.oid, a.attnum) AS column_note
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'rag_mcp' AND c.relkind = 'v'
        ORDER BY c.relname, a.attnum`);

      const notes = await db.readOnly(`
        SELECT c.relname AS view_name, obj_description(c.oid) AS purpose
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'rag_mcp' AND c.relkind = 'v'
        ORDER BY c.relname`);

      const stats = await db.readOnly("SELECT * FROM rag_mcp.v_corpus_stats");

      const byView = new Map<string, { purpose: unknown; columns: unknown[] }>();
      for (const row of notes.rows) {
        byView.set(String(row.view_name), { purpose: row.purpose, columns: [] });
      }
      for (const row of columns.rows) {
        byView.get(String(row.view_name))?.columns.push({
          name: row.column_name,
          type: row.data_type,
          ...(row.column_note ? { note: row.column_note } : {}),
        });
      }

      return json({
        schema: "rag_mcp",
        access: "read-only; SELECT on these views and nothing else in the database",
        guidance: GUIDANCE,
        corpus_stats: stats.rows[0] ?? null,
        views: Object.fromEntries(byView),
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

server.registerTool(
  "corpus_stats",
  {
    title: "Corpus summary",
    description:
      "Counts for the whole corpus: videos, videos with transcripts, chunks, embedded chunks, techniques, instructors, creators, attributions, and when the corpus was last synced. Use this instead of writing your own aggregates for size questions.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await db.readOnly("SELECT * FROM rag_mcp.v_corpus_stats");
      return json(result.rows[0] ?? {});
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

server.registerTool(
  "query_sql",
  {
    title: "Query the corpus with SQL",
    description:
      "Run one read-only SELECT against schema rag_mcp. Use for counting, grouping, ranking, and filtering. Call describe_schema first for the views and columns. Not for semantic search: a LIKE over transcript text misses most of the corpus.",
    inputSchema: {
      sql: z.string().describe("A single SELECT, WITH, TABLE, VALUES, or EXPLAIN statement against rag_mcp views."),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`Maximum rows to return. Default ${config.defaultRowLimit}, maximum ${config.maxRowLimit}.`),
    },
  },
  async ({ sql, limit }) => {
    const guarded = guardSql(sql);
    if (!guarded.ok) return failure(guarded.reason);

    const rowLimit = clampLimit(limit);
    // EXPLAIN returns a plan, not a relation, so it cannot be wrapped in an
    // outer SELECT. It is also cheap and bounded, so it needs no cap.
    const isExplain = /^explain\b/i.test(guarded.sql.trimStart());
    const finalSql = isExplain ? guarded.sql : withRowLimit(guarded.sql, rowLimit);

    try {
      const result = await db.readOnly(finalSql);
      return json(isExplain
        ? { row_count: result.rowCount, columns: result.columns, rows: result.rows }
        : resultPayload(result, rowLimit));
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

server.registerTool(
  "get_video",
  {
    title: "Look up a video",
    description:
      "Fetch one video by its external video_id or slug, with its instructors and its technique list. Use when you have identified a specific video and want everything known about it.",
    inputSchema: {
      video_id: z.string().optional().describe("External video id, for example a YouTube id."),
      slug: z.string().optional().describe("Video slug, if the id is not known."),
    },
  },
  async ({ video_id, slug }) => {
    if (!video_id && !slug) return failure("Provide either video_id or slug.");
    try {
      const video = await db.readOnly(
        "SELECT * FROM rag_mcp.v_videos WHERE ($1::text IS NOT NULL AND video_id = $1) OR ($2::text IS NOT NULL AND slug = $2) LIMIT 1",
        [video_id ?? null, slug ?? null],
      );
      if (video.rowCount === 0) return failure("No video matched that video_id or slug.");

      const id = String(video.rows[0].video_id);
      const [instructors, techniques] = await Promise.all([
        db.readOnly(
          "SELECT creator_slug, display_name, kind, role, confidence FROM rag_mcp.v_video_instructors WHERE video_id = $1 ORDER BY confidence DESC",
          [id],
        ),
        db.readOnly(
          "SELECT technique_name, canonical_position, position, type, difficulty, gi_nogi, start_seconds, end_seconds, summary FROM rag_mcp.v_techniques WHERE video_id = $1 ORDER BY start_seconds",
          [id],
        ),
      ]);

      return json({
        video: video.rows[0],
        instructors: instructors.rows,
        techniques: techniques.rows,
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

server.registerTool(
  "get_instructor",
  {
    title: "Look up an instructor",
    description:
      "Fetch one instructor by slug or name, with their attributed videos and a breakdown of the positions and technique types they cover. Only people are returned; channels and publishers are not instructors.",
    inputSchema: {
      slug: z.string().optional().describe("Creator slug, for example 'john-danaher'."),
      name: z.string().optional().describe("Display name or part of one, if the slug is not known."),
    },
  },
  async ({ slug, name }) => {
    if (!slug && !name) return failure("Provide either slug or name.");
    try {
      const instructor = await db.readOnly(
        `SELECT * FROM rag_mcp.v_instructors
         WHERE ($1::text IS NOT NULL AND slug = $1)
            OR ($2::text IS NOT NULL AND display_name ILIKE '%' || $2 || '%')
         ORDER BY attributed_video_count DESC
         LIMIT 1`,
        [slug ?? null, name ?? null],
      );
      if (instructor.rowCount === 0) {
        return failure(
          "No instructor matched. Note that only creators of kind 'person' are instructors; a channel or publisher will not be found here. Query rag_mcp.v_creators to check.",
        );
      }

      const instructorSlug = String(instructor.rows[0].slug);
      const [videos, coverage] = await Promise.all([
        db.readOnly(
          `SELECT vi.video_id, vi.video_title, vi.role, vi.confidence, v.chunk_count, v.technique_count
           FROM rag_mcp.v_video_instructors vi
           JOIN rag_mcp.v_videos v ON v.video_id = vi.video_id
           WHERE vi.creator_slug = $1
           ORDER BY v.chunk_count DESC
           LIMIT $2`,
          [instructorSlug, config.defaultRowLimit],
        ),
        db.readOnly(
          `SELECT t.canonical_position, t.type, count(*)::int AS techniques
           FROM rag_mcp.v_techniques t
           JOIN rag_mcp.v_video_instructors vi ON vi.video_id = t.video_id
           WHERE vi.creator_slug = $1
           GROUP BY 1, 2
           ORDER BY techniques DESC
           LIMIT 50`,
          [instructorSlug],
        ),
      ]);

      return json({
        instructor: instructor.rows[0],
        videos: videos.rows,
        coverage: coverage.rows,
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

server.registerTool(
  "list_techniques",
  {
    title: "List techniques",
    description:
      "Filter the structured technique cards by position, type, difficulty, gi/no-gi, instructor, or name. Use for questions about what the corpus covers, rather than for what someone said. " +
      "gi_nogi, type and difficulty are matched exactly against the stored values; an unknown value is refused with the list of real ones rather than returning an empty set.",
    inputSchema: {
      position: z
        .string()
        .optional()
        .describe("Matches canonical_position, position, or sub_position as a substring, so 'guard' spans guard, open_guard and half_guard. The values it matched are reported back."),
      type: z.string().optional().describe("Exact technique type, for example 'submission', 'sweep', 'escape', 'pass'."),
      difficulty: z.string().optional().describe("Exact difficulty: fundamental, intermediate, or advanced."),
      gi_nogi: z.string().optional().describe("Exact: gi, no_gi, or both. Spelling is normalised, so 'no-gi' and 'nogi' are accepted; 'gi' means gi only and never no_gi."),
      instructor: z.string().optional().describe("Creator slug, to restrict to one instructor's videos. An unknown slug is refused, not answered with zero rows."),
      name: z.string().optional().describe("Substring of the technique name."),
      limit: z.number().int().optional(),
    },
  },
  async ({ position, type, difficulty, gi_nogi, instructor, name, limit }) => {
    const rowLimit = clampLimit(limit);
    try {
      // Validate before querying. An unrecognised filter value must produce a
      // refusal naming the real values, never a clean empty result: a caller
      // cannot tell "no such value" from "no such technique", and the second
      // is a claim about the corpus that would be false.
      const applied: Record<string, unknown> = {};

      for (const [field, value] of [
        ["gi_nogi", gi_nogi],
        ["type", type],
        ["difficulty", difficulty],
      ] as const) {
        if (value === undefined) continue;
        const resolved = await vocabulary.resolveExact(field, value);
        if (!resolved.ok) return failure(resolved.message);
        applied[field] = resolved.value;
      }

      let positionMatches: string[] | undefined;
      if (position !== undefined) {
        const resolved = await vocabulary.resolveFuzzy("position", position);
        if (!resolved.ok) return failure(resolved.message);
        positionMatches = resolved.matched;
        applied.position = { input: position, matched: resolved.matched };
      }

      if (instructor !== undefined) {
        const resolved = await vocabulary.resolveInstructor(instructor);
        if (!resolved.ok) return failure(resolved.message);
        applied.instructor = resolved.slug;
      }

      const result = await db.readOnly(
        `SELECT t.technique_name, t.canonical_position, t.position, t.sub_position, t.type,
                t.difficulty, t.gi_nogi, t.video_id, t.video_title, t.start_seconds, t.end_seconds, t.summary
         FROM rag_mcp.v_techniques t
         WHERE ($1::text[] IS NULL OR t.canonical_position = ANY($1)
                                   OR t.position = ANY($1)
                                   OR t.sub_position = ANY($1))
           AND ($2::text IS NULL OR t.type = $2)
           AND ($3::text IS NULL OR t.difficulty = $3)
           AND ($4::text IS NULL OR t.gi_nogi = $4)
           AND ($5::text IS NULL OR t.technique_name ILIKE '%'||$5||'%')
           AND ($6::text IS NULL OR EXISTS (
                 SELECT 1 FROM rag_mcp.v_video_instructors vi
                 WHERE vi.video_id = t.video_id AND vi.creator_slug = $6))
         ORDER BY t.technique_name
         LIMIT $7`,
        [
          positionMatches ?? null,
          (applied.type as string | undefined) ?? null,
          (applied.difficulty as string | undefined) ?? null,
          (applied.gi_nogi as string | undefined) ?? null,
          name ?? null,
          (applied.instructor as string | undefined) ?? null,
          rowLimit,
        ],
      );
      // Report what the filters resolved to. "gi" silently including no_gi is
      // exactly the failure this tool shipped with; showing the resolved value
      // makes a wrong filter visible instead of invisible.
      return json({ filters_applied: applied, ...resultPayload(result, rowLimit) });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

server.registerTool(
  "get_transcript_window",
  {
    title: "Read a stretch of transcript",
    description:
      "Return the contiguous transcript for one video between two timestamps. Retrieval returns ~30 second fragments; use this to read the surrounding explanation instead of searching again to reassemble context you have already located.",
    inputSchema: {
      video_id: z.string().describe("External video id."),
      start_seconds: z.number().describe("Start of the window, in seconds."),
      end_seconds: z.number().describe("End of the window, in seconds."),
    },
  },
  async ({ video_id, start_seconds, end_seconds }) => {
    if (end_seconds <= start_seconds) return failure("end_seconds must be greater than start_seconds.");
    // A whole long video's transcript would swamp the caller's context and is
    // never what the question needed.
    if (end_seconds - start_seconds > 1_800) {
      return failure("Window is longer than 30 minutes. Request a narrower range.");
    }
    try {
      const result = await db.readOnly(
        `SELECT chunk_index, start_seconds, end_seconds, text, video_title, channel_name, instructor_name, video_url
         FROM rag_mcp.v_chunks
         WHERE video_id = $1 AND start_seconds < $3 AND end_seconds > $2
         ORDER BY chunk_index`,
        [video_id, start_seconds, end_seconds],
      );
      if (result.rowCount === 0) {
        return failure("No transcript chunks in that window. The video may have no transcript; check has_transcript in v_videos.");
      }
      const first = result.rows[0];
      const stitched = stitchTranscript(result.rows.map((row) => String(row.text)));
      return json({
        video_id,
        video_title: first.video_title,
        channel_name: first.channel_name,
        instructor_name: first.instructor_name,
        video_url: first.video_url,
        requested_window: { start_seconds, end_seconds },
        actual_window: {
          start_seconds: first.start_seconds,
          end_seconds: result.rows[result.rowCount - 1].end_seconds,
        },
        chunk_count: result.rowCount,
        // Chunks overlap by 6-8 seconds on purpose, so a plain join repeats a
        // sentence at every boundary. Stitching removes the duplicate and
        // reports any boundary it could not resolve, rather than leaving a
        // caller to notice the repetition itself.
        transcript: stitched.transcript,
        ...(stitched.unmatched_boundaries > 0
          ? {
              note: `${stitched.unmatched_boundaries} of ${result.rowCount - 1} chunk boundaries had no detectable overlap and may repeat text.`,
            }
          : {}),
        chunks: result.rows.map((row) => ({
          chunk_index: row.chunk_index,
          start_seconds: row.start_seconds,
          end_seconds: row.end_seconds,
        })),
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  },
);

// ── retrieval ───────────────────────────────────────────────────────────────

/**
 * Content filters, offered as a choice rather than a single baked-in rule
 * because no available signal is correct on its own, and this is measurable:
 *
 *   - martial_arts_relevance answers "is there a technique to extract", not
 *     "is this useful to a practitioner". It rejects Zahabi AMAs on back
 *     health, which are worth keeping, and it never ran at all on some rows.
 *   - technique_count = 0 catches match footage and the three finance videos
 *     sitting in the corpus with a null relevance, but also catches genuinely
 *     good conceptual talks that produced no cards.
 *
 * Until a real content_kind classification exists, the honest move is to let
 * the caller pick and to report what each choice removed.
 */
const FILTERS = {
  none: "Nothing removed. This is what search.zencub.com returns today.",
  curated: "Removes videos classified content_kind = event_coverage, no_content or off_topic. Unclassified videos are kept, because NULL is 'not looked at yet', not 'fine'.",
  flagged: "Removes videos the pipeline marked status=failed, martial_arts_relevance=no.",
  instructional: "Removes videos that produced zero technique cards.",
  strict: "Removes both of the above.",
} as const;
type FilterName = keyof typeof FILTERS;

type VideoFacts = {
  title: string | null;
  channel_name: string | null;
  instructor_name: string | null;
  video_url: string | null;
  platform: string | null;
  status: string | null;
  martial_arts_relevance: string | null;
  content_kind: string | null;
  technique_count: number | null;
};

// The only two content_kind values retrieval drops. Everything else stays:
// training_advice, interview and promotional are all things a practitioner may
// legitimately be searching for, and the plan's whole argument against the
// relevance flag was that it destroyed the first two.
const EXCLUDED_CONTENT_KINDS = new Set(["event_coverage", "no_content", "off_topic"]);

function excludedBy(facts: VideoFacts | undefined, filter: FilterName): string | null {
  if (!facts || filter === "none") return null;
  const flagged = facts.status === "failed" && facts.martial_arts_relevance === "no";
  const noCards = (facts.technique_count ?? 0) === 0;
  if ((filter === "flagged" || filter === "strict") && flagged) return "flagged_non_relevant";
  if ((filter === "instructional" || filter === "strict") && noCards) return "no_technique_cards";
  // NULL is deliberately not excluded. An unclassified video is a video nobody
  // has judged, which is a different statement from one judged unsuitable, and
  // conflating those two is exactly how martial_arts_relevance quietly dropped
  // 150 videos it had never run on.
  if (filter === "curated" && facts.content_kind !== null
      && EXCLUDED_CONTENT_KINDS.has(facts.content_kind)) {
    return `content_kind_${facts.content_kind}`;
  }
  return null;
}

server.registerTool(
  "search_transcripts",
  {
    title: "Search the transcript corpus",
    description:
      "Search what instructors actually said, across 14,274 transcript chunks. Ranking is the app's own pipeline -- hybrid fusion, LLM rerank, per-video diversity and timestamp refinement -- not a keyword match. Returns timestamped evidence with deep links; follow up with get_transcript_window to read around a hit, or get_instructor to see what else that person covers.",
    inputSchema: {
      query: z.string().min(2).describe("What to search for, in natural language."),
      mode: z.enum(["text", "semantic", "both"]).default("both")
        .describe("Which retrieval side to use. 'both' lets the app fuse keyword and embeddings, and is almost always right; 'text' and 'semantic' pin one side but still get the rerank and diversity pass."),
      limit: z.number().int().min(1).max(25).default(10).describe("Results to return."),
      // Default stays 'flagged' until the corpus is fully classified. 'curated'
      // is the better gate and is the intended default, but on a partly
      // classified corpus it silently degrades to 'none', which would put
      // competition commentary back at the top of exactly the queries this was
      // built to fix. Flip the default in the same change that verifies
      // coverage, not before.
      filter: z.enum(["none", "curated", "flagged", "instructional", "strict"]).default("flagged")
        .describe("Which non-instructional content to drop. 'curated' uses the content_kind classification and is the intended default once the corpus is fully classified; 'none' reproduces the live site."),
    },
  },
  async ({ query, mode, limit, filter }) => {
    // Over-fetching no longer widens the pool: the app's rerank narrows to its
    // own result limit before this route slices, so asking for triple returns
    // the same rows. Ask for what was requested and let the pipeline disclose
    // when it returned fewer. Retrieval now runs an embedding plus a rerank, so
    // it is slower than the old two-endpoint call; the timeout allows for that.
    const { hits, warnings, meta } = await retrieve(mode, query, limit, 45_000);
    if (hits.length === 0) {
      return json({
        query,
        mode,
        filter,
        ...meta,
        results: [],
        warnings: warnings.length > 0 ? warnings : ["No matches. Retrieval reached the corpus and found nothing."],
      });
    }

    const videoIds = [...new Set(hits.map((hit) => hit.video_id))];
    const facts = new Map<string, VideoFacts>();
    try {
      const result = await db.readOnly(
        `SELECT video_id, title, channel_name, instructor_name, video_url, platform,
                status, martial_arts_relevance, content_kind, technique_count
         FROM rag_mcp.v_videos WHERE video_id = ANY($1::text[])`,
        [videoIds],
      );
      for (const row of result.rows) facts.set(String(row.video_id), row as unknown as VideoFacts);
    } catch (error) {
      warnings.push(`Could not enrich results from the corpus: ${errorMessage(error)}`);
    }

    const removed: Record<string, number> = {};
    const kept: RetrievalHit[] = [];
    for (const hit of hits) {
      const reason = excludedBy(facts.get(hit.video_id), filter);
      if (reason) {
        removed[reason] = (removed[reason] ?? 0) + 1;
        continue;
      }
      kept.push(hit);
    }

    const page = kept.slice(0, limit);
    return json({
      query,
      mode,
      filter,
      filter_meaning: FILTERS[filter],
      // What the app actually ran, so a caller can tell a hybrid result from a
      // text-only fallback rather than inferring it from result quality.
      ...meta,
      retrieved: hits.length,
      removed_by_filter: removed,
      // How many of the retrieved videos the classifier has not judged yet.
      // Without this a caller cannot tell "the gate found nothing to drop"
      // from "the gate has not run on any of this", which are very different
      // claims about the same empty removed_by_filter.
      unclassified_content_kind: hits.filter(
        (hit) => (facts.get(hit.video_id)?.content_kind ?? null) === null,
      ).length,
      returned: page.length,
      warnings: warnings.length > 0 ? warnings : undefined,
      results: page.map((hit) => {
        const video = facts.get(hit.video_id);
        const link = deepLink(video?.video_url ?? null, video?.platform ?? null, hit.start_seconds);
        return {
          video_id: hit.video_id,
          video_title: video?.title ?? null,
          channel_name: video?.channel_name ?? null,
          instructor_name: video?.instructor_name ?? null,
          start_seconds: hit.start_seconds,
          end_seconds: hit.end_seconds,
          ...link,
          has_technique_cards: (video?.technique_count ?? 0) > 0,
          content_kind: video?.content_kind ?? null,
          text: hit.text,
        };
      }),
    });
  },
);

server.registerTool(
  "health",
  {
    title: "Server health",
    description:
      "Confirm the server can reach the database and the app's retrieval endpoint, and report which project and role it is using. Call this when a tool has failed and you need to tell whether the server, the app, or the query is at fault.",
    inputSchema: {},
  },
  async () => {
    try {
      const started = Date.now();
      const result = await db.readOnly(
        "SELECT current_user AS role, current_setting('default_transaction_read_only') AS read_only, (SELECT count(*) FROM rag_mcp.v_corpus_stats) AS stats_rows",
      );
      const dbLatency = Date.now() - started;

      // search_transcripts depends on the app, not just the database, so a
      // health tool that only checks Postgres would report ok while retrieval
      // was dead.
      const retrievalUrl = retrievalBaseUrl();
      let retrieval: Record<string, unknown>;
      const retrievalStarted = Date.now();
      try {
        // Probe /api/health, not a real search. The retrieval route runs an
        // embedding plus a rerank and writes a row to rag_search_logs, so
        // health checks used to cost money and pollute the analytics they were
        // meant to be independent of. /api/health is also the one path the MCP
        // surface serves besides retrieval, so this works on every build.
        const response = await fetch(`${retrievalUrl}/api/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        retrieval = {
          ok: response.ok,
          url: retrievalUrl,
          status: response.status,
          latency_ms: Date.now() - retrievalStarted,
        };
      } catch (error) {
        retrieval = {
          ok: false,
          url: retrievalUrl,
          error: errorMessage(error),
          hint: "search_transcripts will fail. The SQL tools are unaffected.",
        };
      }

      return json({
        ok: true,
        project_ref: config.projectRef,
        latency_ms: dbLatency,
        ...result.rows[0],
        retrieval,
      });
    } catch (error) {
      return failure(`Database unreachable: ${errorMessage(error)}`);
    }
  },
);

// ── lifecycle ───────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  await db.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout carries the protocol; anything written there corrupts the stream.
process.stderr.write(`[zencub-rag-mcp] ready (project ${config.projectRef})\n`);
