export {};

const baseUrl = (process.env.RAG_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const action = process.argv[2] === "edit" || process.argv[2] === "reject" ? process.argv[2] : "approve";
const marker = crypto.randomUUID();
const title = `Approval test ${marker.slice(0, 8)}`;
const content = `Original reviewed content for test ${marker}.`;

const started = await fetch(`${baseUrl}/api/rag/graph-note`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "start", title, content }),
});
const pending = await started.json() as { error?: string; status?: string; note_key?: string; proposal?: { title: string; content: string } };
if (!started.ok || pending.status !== "pending_review" || !pending.note_key || !pending.proposal) {
  throw new Error(pending.error ?? "Graph did not interrupt for review.");
}

const reviewedTitle = action === "edit" ? `${title} edited` : title;
const reviewedContent = action === "edit" ? `${content} Human edit applied.` : content;
const resumed = await fetch(`${baseUrl}/api/rag/graph-note`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "resume",
    note_key: pending.note_key,
    decision: action === "edit"
      ? { action, title: reviewedTitle, content: reviewedContent }
      : { action },
  }),
});
const result = await resumed.json() as { error?: string; status?: string; note_id?: string | null; title?: string; content?: string };
if (!resumed.ok) throw new Error(result.error ?? "Review resume failed.");
if (action === "reject" && (result.status !== "rejected" || result.note_id)) throw new Error("Reject unexpectedly wrote a note.");
if (action !== "reject" && (result.status !== "saved" || !result.note_id)) throw new Error("Approved note was not saved.");
if (action === "edit" && (result.title !== reviewedTitle || result.content !== reviewedContent)) throw new Error("Edited content was not preserved.");

console.log(JSON.stringify({ action, note_key: pending.note_key, status: result.status, note_id: result.note_id ?? null }, null, 2));
