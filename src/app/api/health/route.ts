import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase";

// Inlined at build time by next.config.ts. Reported on the failing path too:
// "which commit is live" has to stay answerable when the database is down,
// because that is exactly when it gets asked.
const build = {
  sha: process.env.BUILD_SHA ?? "unknown",
  built_at: process.env.BUILD_TIME ?? "unknown",
};

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { count, error } = await supabase
      .from("rag_transcript_chunks")
      .select("id", { count: "exact", head: true });

    if (error) {
      return NextResponse.json({ ok: false, build, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, build, chunks: count ?? 0 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, build, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
