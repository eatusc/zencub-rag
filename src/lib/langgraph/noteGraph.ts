import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { getLangGraphCheckpointer } from "@/lib/langgraph/checkpointer";
import { langfuseCallbacks } from "@/lib/langfuseHandler";
import { createServerSupabase } from "@/lib/supabase";

export type NoteReviewDecision =
  | { action: "approve" }
  | { action: "edit"; title: string; content: string }
  | { action: "reject" };

export type NoteReviewProposal = {
  kind: "research_note_review";
  note_key: string;
  title: string;
  content: string;
};

type NoteStatus = "draft" | "approved" | "edited" | "rejected" | "saved";

const NoteState = Annotation.Root({
  noteKey: Annotation<string>(),
  threadId: Annotation<string>(),
  title: Annotation<string>(),
  content: Annotation<string>(),
  status: Annotation<NoteStatus>({ reducer: (_p, n) => n, default: () => "draft" }),
  savedNoteId: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
});

type State = typeof NoteState.State;

function reviewNode(state: State): Partial<State> {
  const decision = interrupt<NoteReviewProposal, NoteReviewDecision>({
    kind: "research_note_review",
    note_key: state.noteKey,
    title: state.title,
    content: state.content,
  });

  if (decision.action === "reject") return { status: "rejected" };
  if (decision.action === "edit") {
    return {
      title: decision.title.trim().slice(0, 200),
      content: decision.content.trim().slice(0, 20_000),
      status: "edited",
    };
  }
  return { status: "approved" };
}

async function writeNode(state: State): Promise<Partial<State>> {
  if (!state.title || !state.content) throw new Error("Reviewed note title and content are required.");
  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("rag_research_notes")
    .upsert({
      note_key: state.noteKey,
      thread_id: state.threadId,
      title: state.title,
      content: state.content,
      review_action: state.status === "edited" ? "edit" : "approve",
      updated_at: new Date().toISOString(),
    }, { onConflict: "note_key" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { status: "saved", savedNoteId: data.id as string };
}

function buildNoteGraph() {
  return new StateGraph(NoteState)
    .addNode("review_note", reviewNode)
    .addNode("write_note", writeNode)
    .addEdge(START, "review_note")
    .addConditionalEdges("review_note", (state: State) => state.status === "rejected" ? "reject" : "write", {
      reject: END,
      write: "write_note",
    })
    .addEdge("write_note", END)
    .compile({ checkpointer: getLangGraphCheckpointer() });
}

let noteGraph: ReturnType<typeof buildNoteGraph> | null = null;

function getNoteGraph() {
  if (!noteGraph) noteGraph = buildNoteGraph();
  return noteGraph;
}

function config(noteKey: string) {
  return { configurable: { thread_id: `note:${noteKey}` } };
}

function proposalFrom(result: unknown): NoteReviewProposal | null {
  const interrupts = (result as { __interrupt__?: Array<{ value?: unknown }> }).__interrupt__;
  const value = interrupts?.[0]?.value;
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "research_note_review") return null;
  return value as NoteReviewProposal;
}

export async function startNoteReview(input: {
  noteKey: string;
  threadId: string;
  title: string;
  content: string;
}) {
  const result = await getNoteGraph().invoke({
    noteKey: input.noteKey,
    threadId: input.threadId,
    title: input.title,
    content: input.content,
  }, { ...config(input.noteKey), callbacks: langfuseCallbacks() });
  return { result, proposal: proposalFrom(result) };
}

export async function resumeNoteReview(noteKey: string, decision: NoteReviewDecision) {
  const result = await getNoteGraph().invoke(new Command({ resume: decision }), { ...config(noteKey), callbacks: langfuseCallbacks() });
  return {
    status: result.status,
    noteId: result.savedNoteId,
    title: result.title,
    content: result.content,
  };
}
