import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getServerEnv } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase";
import type { RagAnalysis, RagSearchResult } from "@/lib/types";

type SearchRow = RagSearchResult & {
  similarity?: number;
};

const RESULT_LIMIT = 8;

function asNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function timestampUrl(url: string | null | undefined, startSeconds: number) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const seconds = Math.max(0, Math.floor(startSeconds));
    if (parsed.hostname.includes("youtube.com")) {
      parsed.searchParams.set("t", `${seconds}s`);
      return parsed.toString();
    }
    if (parsed.hostname.includes("youtu.be")) {
      parsed.searchParams.set("t", String(seconds));
      return parsed.toString();
    }
  } catch {
    return url;
  }

  return url;
}

function formatSource(row: SearchRow, index: number) {
  const start = asNumber(row.start_seconds);
  const end = asNumber(row.end_seconds);
  return {
    id: index + 1,
    title: row.metadata?.video_title ?? row.video_id,
    citation: row.metadata?.citation ?? `${row.video_id} @ ${Math.floor(start)}`,
    channel: row.metadata?.channel_name ?? row.metadata?.instructor_name ?? null,
    start_seconds: start,
    end_seconds: end,
    source_url: row.metadata?.video_url ?? null,
    watch_url: timestampUrl(row.metadata?.video_url, start),
    rank: row.rank ?? row.similarity ?? 0,
    text: row.text.slice(0, 1400),
  };
}

function coerceAnalysis(value: unknown): RagAnalysis {
  const fallback: RagAnalysis = {
    summary: "No analysis returned.",
    best_moments: [],
    key_details: [],
    study_order: [],
    next_searches: [],
    caveats: ["The model did not return the expected JSON shape."],
  };

  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;

  return {
    summary: typeof raw.summary === "string" ? raw.summary : fallback.summary,
    best_moments: Array.isArray(raw.best_moments) ? raw.best_moments.slice(0, 6).map((moment, index) => {
      const item = moment && typeof moment === "object" ? moment as Record<string, unknown> : {};
      return {
        rank: typeof item.rank === "number" ? item.rank : index + 1,
        title: typeof item.title === "string" ? item.title : "Untitled source",
        focus: typeof item.focus === "string" ? item.focus : "Useful source moment",
        why: typeof item.why === "string" ? item.why : "Relevant to the search.",
        start_seconds: asNumber(item.start_seconds as number | string | null | undefined),
        end_seconds: asNumber(item.end_seconds as number | string | null | undefined),
        citation: typeof item.citation === "string" ? item.citation : "No citation",
        watch_url: typeof item.watch_url === "string" ? item.watch_url : null,
      };
    }) : [],
    key_details: Array.isArray(raw.key_details) ? raw.key_details.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    study_order: Array.isArray(raw.study_order) ? raw.study_order.filter((item): item is string => typeof item === "string").slice(0, 6) : [],
    next_searches: Array.isArray(raw.next_searches) ? raw.next_searches.filter((item): item is string => typeof item === "string").slice(0, 6) : [],
    caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((item): item is string => typeof item === "string").slice(0, 4) : [],
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { query?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";

  if (query.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }

  try {
    const env = getServerEnv();
    if (!env.openaiApiKey) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    const supabase = createServerSupabase();
    const { data, error } = await supabase.rpc("search_rag_transcript_chunks", {
      query_text: query,
      match_count: RESULT_LIMIT,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const sources = ((data ?? []) as SearchRow[]).map(formatSource);
    if (sources.length === 0) {
      return NextResponse.json({ error: "No sources found to analyze." }, { status: 404 });
    }

    const openai = new OpenAI({ apiKey: env.openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: env.ragAnalyzeModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a concise BJJ research assistant.",
            "Use only the provided transcript chunks. Do not invent videos, timestamps, techniques, or claims.",
            "Do not quote long transcript passages. Summarize in your own words.",
            "Return valid JSON only with keys: summary, best_moments, key_details, study_order, next_searches, caveats.",
            "best_moments must be an array of 3-6 objects with: rank, title, focus, why, start_seconds, end_seconds, citation, watch_url.",
            "key_details must contain 4-7 short technical takeaways.",
            "study_order must contain 3-5 ordered study steps.",
            "next_searches must contain 3-5 short BJJ search queries.",
            "caveats must contain 1-3 honest limitations based on the supplied evidence.",
            "For each best_moment, copy citation and watch_url exactly from one of the provided sources.",
            "Prioritize the most useful watch moments for learning the searched topic, not just the highest lexical match.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            query,
            task: "Analyze these search results and identify the most useful watch moments and study takeaways.",
            sources,
          }),
        },
      ],
    });

    const content = completion.choices[0]?.message.content ?? "{}";
    const parsed = JSON.parse(content) as unknown;
    const analysis = coerceAnalysis(parsed);

    return NextResponse.json({
      query,
      model: env.ragAnalyzeModel,
      source_count: sources.length,
      analysis,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
