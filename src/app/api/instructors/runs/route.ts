// Stored comparisons for the public instructors app: the recent strip on the
// landing page, and the permalink behind /c/<id>.
//
// Only runs marked with the instructors surface are readable here, so nothing
// typed into the internal demo can surface on the public site.

import { NextRequest, NextResponse } from "next/server";
import { getPublicComparison, listPublicComparisonCards } from "@/lib/instructorCompareStorage";
import { logWorkflowError } from "@/lib/workflowErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 6;

function uuid(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

export async function GET(request: NextRequest) {
  const rawId = request.nextUrl.searchParams.get("id");

  try {
    if (rawId !== null) {
      const id = uuid(rawId);
      if (!id) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const run = await getPublicComparison(id);
      if (!run) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return NextResponse.json({ run });
    }

    return NextResponse.json({ runs: await listPublicComparisonCards(RECENT_LIMIT) });
  } catch (error) {
    logWorkflowError("instructors-runs", error);
    return NextResponse.json({ error: "Could not load comparisons." }, { status: 500 });
  }
}
