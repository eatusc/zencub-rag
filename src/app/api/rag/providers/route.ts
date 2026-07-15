import { NextResponse } from "next/server";
import { detectProviders } from "@/lib/answerProviders";
import { getServerEnv } from "@/lib/env";
import { pickDefaultProvider } from "@/lib/providers";

// Probes which answer providers are actually reachable on this host so the UI
// offers local Qwen, OpenRouter Qwen3 235B, Claude CLI, and OpenAI in that order.
// Not cached — availability is host-specific and cheap.
export async function GET() {
  try {
    const env = getServerEnv();
    const providers = await detectProviders(env);
    return NextResponse.json({
      providers,
      default: pickDefaultProvider(providers),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
