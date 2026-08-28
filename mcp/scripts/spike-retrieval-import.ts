// Phase 2 Spike A: can a plain Node process import the app's retrieval core?
//
// Decides whether search_transcripts calls ragPipeline in-process or goes over
// HTTP to /api/rag/search. Imports only; it calls nothing, so it needs no
// credentials and touches no database.
export {};

const expected = [
  "vectorResults",
  "textResults",
  "metadataResults",
  "enrichCandidates",
  "uniqueRows",
];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) failures += 1;
}

const pipeline = await import("@/lib/ragPipeline");
check("import @/lib/ragPipeline", true);

for (const name of expected) {
  check(`export ${name}`, typeof (pipeline as Record<string, unknown>)[name] === "function");
}

const retrieval = await import("@/lib/ragRetrieval");
check("import @/lib/ragRetrieval", true, `${Object.keys(retrieval).length} exports`);

const utils = await import("@/lib/ragUtils");
check("import @/lib/ragUtils", typeof utils.formatRagSource === "function");

const refine = await import("@/lib/timestampRefinement");
check("import @/lib/timestampRefinement", typeof refine.refineResultTimestamps === "function");

console.log(failures === 0 ? "\nSPIKE A: viable" : `\nSPIKE A: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
