// Next.js runs this once at server startup. It registers the Langfuse
// OpenTelemetry span processor so LangGraph/LangChain traces (emitted by the
// @langfuse/langchain CallbackHandler) are exported to the self-hosted Langfuse.
// Config (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASEURL) is read
// from env by LangfuseSpanProcessor.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return;

  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");

  const provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  provider.register();
}
