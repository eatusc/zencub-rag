// Whether Instructor Compare runs semantic (vector) retrieval for a provider.
//
// Vector search needs one OpenAI query embedding (text-embedding-3-small,
// about $0.00002 a query). It cannot be swapped for a local embedding model:
// the stored chunk vectors were made with that model, and a query has to be
// embedded by the same one to land on the same map.
//
// Local Qwen used to skip it to stay "zero paid", which quietly turned every
// Local Qwen comparison into keyword + metadata retrieval. It is now on by
// default; RAG_COMPARE_LOCAL_SEMANTIC=off restores strict zero-paid mode.

export type SemanticRetrievalDecision =
  | { enabled: true }
  | { enabled: false; reason: string };

export function semanticRetrievalFor(
  provider: string,
  options: { localSemantic: boolean; hasOpenAiKey: boolean },
): SemanticRetrievalDecision {
  if (!options.hasOpenAiKey) {
    return { enabled: false, reason: "no OpenAI key configured; retrieval is keyword + metadata only" };
  }
  if (provider === "qwen" && !options.localSemantic) {
    return { enabled: false, reason: "off for Local Qwen (RAG_COMPARE_LOCAL_SEMANTIC=off); zero paid calls" };
  }
  return { enabled: true };
}

// A run is zero-paid only when it makes no paid call at all, embedding included.
export function isZeroPaidRun(provider: string, semantic: SemanticRetrievalDecision): boolean {
  return provider === "qwen" && !semantic.enabled;
}
