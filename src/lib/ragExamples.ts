export type RagExample = {
  query: string;
  useCase: string;
  goodResult: string;
  expectedTerms: string[][];
};

export const ragExamples: RagExample[] = [
  {
    query: "knee cut",
    useCase: "Find passing clips that explain the knee-cut pass and common finishing problems.",
    goodResult: "Top results should mention knee-cut mechanics, finishing, underhooks, knee shields, or passing into side control.",
    expectedTerms: [["knee"], ["cut"]],
  },
  {
    query: "saddle",
    useCase: "Find leg-lock position clips, saddle counters, and entries.",
    goodResult: "Top results should clearly discuss saddle position, counters, leg entanglements, or heel-hook threats.",
    expectedTerms: [["saddle"]],
  },
  {
    query: "crossface",
    useCase: "Find pressure/control clips where head position or shoulder control matters.",
    goodResult: "Top results should discuss crossface pressure, head control, side control, half guard, or pinning.",
    expectedTerms: [["crossface", "cross face"]],
  },
  {
    query: "underhook half guard",
    useCase: "Find half-guard clips focused on underhooks, dogfight, and coming up from bottom.",
    goodResult: "Top results should include half guard plus underhook/dogfight concepts.",
    expectedTerms: [["underhook"], ["half guard", "halfguard"]],
  },
  {
    query: "guard retention",
    useCase: "Find clips about recovering guard, retaining frames, and preventing passes.",
    goodResult: "Top results should mention guard retention or recovering guard against passing pressure.",
    expectedTerms: [["guard"], ["retention", "recover", "recovery"]],
  },
  {
    query: "single leg x",
    useCase: "Find SLX/X-guard clips and transitions from seated guard.",
    goodResult: "Top results should mention single-leg X, SLX, X guard, or seated guard entries.",
    expectedTerms: [["single leg x", "slx", "x guard", "xguard"]],
  },
  {
    query: "kimura trap",
    useCase: "Find clips about the Kimura trap system, submission chains, and control sequences.",
    goodResult: "Top results should mention Kimura trap, Kimura control, or related attack options.",
    expectedTerms: [["kimura", "kimora"], ["trap"]],
  },
  {
    query: "body lock pass",
    useCase: "Find no-gi body-lock passing clips and details for controlling hips.",
    goodResult: "Top results should mention body-lock passing, hip control, or locking hands around the hips.",
    expectedTerms: [["body"], ["lock"], ["pass", "passing"]],
  },
  {
    query: "deep half",
    useCase: "Find deep-half guard clips, sweeps, and retention options.",
    goodResult: "Top results should mention deep half, half guard, sweeps, or deep-half retention.",
    expectedTerms: [["deep"], ["half"]],
  },
];
