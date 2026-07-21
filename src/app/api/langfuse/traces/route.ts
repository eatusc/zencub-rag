import { NextResponse } from "next/server";

// Server-only: reads Langfuse traces (self-hosted) using keys from env. The keys
// never reach the client — only the summarized trace data does.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LfObservation = {
  id: string;
  name?: string;
  type?: string;
  startTime?: string;
  endTime?: string;
  parentObservationId?: string | null;
  input?: unknown;
  output?: unknown;
  usage?: { totalTokens?: number } | null;
};

type Node = { name: string; type: string; depth: number; durMs: number | null; tokens: number | null };

function durMs(o: LfObservation): number | null {
  if (!o.startTime || !o.endTime) return null;
  const d = new Date(o.endTime).getTime() - new Date(o.startTime).getTime();
  return Number.isFinite(d) ? Math.round(d) : null;
}

function buildNodes(obs: LfObservation[]): Node[] {
  const byId = new Map(obs.map((o) => [o.id, o]));
  const depthOf = (o: LfObservation): number => {
    let d = 0;
    let cur: LfObservation | undefined = o;
    while (cur?.parentObservationId && byId.has(cur.parentObservationId) && d < 20) {
      d++;
      cur = byId.get(cur.parentObservationId);
    }
    return d;
  };
  return [...obs]
    .sort((a, b) => new Date(a.startTime ?? 0).getTime() - new Date(b.startTime ?? 0).getTime())
    .map((o) => ({
      name: o.name || "(node)",
      type: o.type || "SPAN",
      depth: depthOf(o),
      durMs: durMs(o),
      tokens: o.usage?.totalTokens ?? null,
    }));
}

function extract(obs: LfObservation[]): { query: string; provider: string; answer: string } {
  const root = obs.find((o) => !o.parentObservationId) ?? obs[0];
  const inp = (root?.input ?? {}) as Record<string, unknown>;
  const out = (root?.output ?? {}) as Record<string, unknown>;
  const query = typeof inp.query === "string" ? inp.query : "";
  const provider =
    (inp.requestedProvider as string) || (inp.provider as string) || (inp.selectedProvider as string) || "";
  let answer = "";
  if (typeof out.answer === "string") answer = out.answer;
  else if (Array.isArray(out.conversation) && out.conversation.length) {
    const last = out.conversation[out.conversation.length - 1] as { answer?: string };
    answer = typeof last?.answer === "string" ? last.answer : "";
  }
  return { query, provider, answer };
}

export async function GET() {
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  const base = process.env.LANGFUSE_BASEURL;
  if (!pk || !sk || !base) return NextResponse.json({ configured: false, traces: [] });

  const auth = "Basic " + Buffer.from(`${pk}:${sk}`).toString("base64");
  try {
    const listRes = await fetch(`${base}/api/public/traces?limit=12`, {
      headers: { Authorization: auth },
      cache: "no-store",
    });
    if (!listRes.ok) return NextResponse.json({ configured: true, error: `list ${listRes.status}`, traces: [] });
    const list: Array<{ id: string; timestamp?: string; latency?: number; totalCost?: number }> =
      (await listRes.json()).data ?? [];

    const traces = await Promise.all(
      list.map(async (t) => {
        let obs: LfObservation[] = [];
        try {
          const dRes = await fetch(`${base}/api/public/traces/${t.id}`, {
            headers: { Authorization: auth },
            cache: "no-store",
          });
          if (dRes.ok) obs = (await dRes.json()).observations ?? [];
        } catch {
          /* leave obs empty */
        }
        const { query, provider, answer } = extract(obs);
        return {
          id: t.id,
          timestamp: t.timestamp ?? "",
          latencyMs: t.latency != null ? Math.round(t.latency * 1000) : null,
          cost: t.totalCost ?? null,
          spanCount: obs.length,
          query,
          provider,
          answerPreview: answer.slice(0, 280),
          nodes: buildNodes(obs),
        };
      }),
    );

    return NextResponse.json({ configured: true, projectId: process.env.LANGFUSE_PROJECT ?? "zencub-rag", baseUrl: base, traces });
  } catch (e) {
    return NextResponse.json({ configured: true, error: e instanceof Error ? e.message : String(e), traces: [] });
  }
}
