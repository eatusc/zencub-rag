// Permalink for a stored comparison. Every finished run already persists, so a
// shareable URL costs nothing beyond routing to it.
//
// The middleware only allows this path on the instructors deployment, and the
// API behind it only returns runs marked with that surface, so a demo run
// cannot be reached by guessing an id here.

import { notFound } from "next/navigation";
import { InstructorsApp } from "@/components/InstructorsApp";
import { getAppMode } from "@/lib/appMode";

export const dynamic = "force-dynamic";

export default async function ComparisonPermalink({ params }: { params: Promise<{ id: string }> }) {
  if (getAppMode() !== "instructors") notFound();
  const { id } = await params;
  return <InstructorsApp initialRunId={id} />;
}
