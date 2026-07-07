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
  {
    query: "rear naked choke",
    useCase: "Find back-control finishing clips and rear-naked-choke escape details.",
    goodResult: "Top results should mention rear naked choke mechanics, back control, finishing, or escapes.",
    expectedTerms: [["rear"], ["naked"], ["choke"]],
  },
  {
    query: "armbar",
    useCase: "Find armbar attacks, defenses, and transition chains from guard, mount, or side control.",
    goodResult: "Top results should mention armbar or arm-bar entries, finishes, or defenses.",
    expectedTerms: [["armbar", "arm bar"]],
  },
  {
    query: "triangle choke",
    useCase: "Find triangle-choke setup, finishing, and escape clips.",
    goodResult: "Top results should mention triangle-choke mechanics, posture control, or triangle escapes.",
    expectedTerms: [["triangle"], ["choke", "choked"]],
  },
  {
    query: "arm triangle",
    useCase: "Find arm-triangle attacks, finishing mechanics, and defensive escapes.",
    goodResult: "Top results should mention arm triangle, head-and-arm control, finishing, or escaping.",
    expectedTerms: [["arm"], ["triangle"]],
  },
  {
    query: "ankle lock",
    useCase: "Find straight ankle-lock finishing details, entries, and counters.",
    goodResult: "Top results should mention ankle locks, foot locks, leg-lock entries, or finishing details.",
    expectedTerms: [["ankle"], ["lock", "locks"]],
  },
  {
    query: "heel hook",
    useCase: "Find heel-hook entries, finishing mechanics, defensive positioning, and leg-lock threats.",
    goodResult: "Top results should mention heel hooks, leg locks, or related inside/outside heel exposure.",
    expectedTerms: [["heel"], ["hook", "hooks"]],
  },
  {
    query: "mount escape",
    useCase: "Find beginner and advanced mount escapes, frames, bridges, and elbow-knee recovery.",
    goodResult: "Top results should mention mount escapes, bridging, frames, hip escapes, or recovering guard.",
    expectedTerms: [["mount"], ["escape", "escapes"]],
  },
  {
    query: "closed guard pass",
    useCase: "Find closed-guard opening and passing instruction.",
    goodResult: "Top results should mention closed guard, guard breaks, posture, and passing.",
    expectedTerms: [["closed"], ["guard"], ["pass", "passing"]],
  },
  {
    query: "bow and arrow choke",
    useCase: "Find gi back-control finishing clips and bow-and-arrow choke mechanics.",
    goodResult: "Top results should mention bow-and-arrow choke details, back control, lapel grips, or finishing.",
    expectedTerms: [["bow"], ["arrow"], ["choke"]],
  },
  {
    query: "omoplata",
    useCase: "Find omoplata setup, finishing, and chaining options from guard.",
    goodResult: "Top results should mention omoplata entries, shoulder locks, guard attacks, or follow-up chains.",
    expectedTerms: [["omoplata"]],
  },
];
