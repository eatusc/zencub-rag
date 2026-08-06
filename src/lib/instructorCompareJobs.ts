// In-process registry for comparison workflows that outlive their request.
//
// A comparison takes roughly a minute and has been measured at 114 seconds.
// Cloudflare cuts an origin response off at 100, so the route cannot simply
// await the graph and return it. Instead the POST starts a job, returns the
// thread id, and the browser polls this registry for the trace as it fills in.
//
// A Map is enough here for the same reason the rate limiter uses one: each
// surface is a single long-lived `next start` process, not serverless
// functions. The durable copy of the work is the LangGraph checkpoint and the
// stored run row; this registry only holds the live view, so losing it on a
// restart costs a spinner, not a result.

import type { RagGraphTraceEntry, RagStoredInstructorCompareRun } from "@/lib/types";

export type CompareJobStatus = "running" | "complete" | "error";

export type CompareJob = {
  threadId: string;
  query: string;
  status: CompareJobStatus;
  startedAt: number;
  finishedAt: number | null;
  trace: RagGraphTraceEntry[];
  result: RagStoredInstructorCompareRun | null;
  error: string | null;
};

// Each job holds a graph running about a dozen model calls, several of them in
// parallel. Past a handful in flight the box, the OpenAI rate limit, and every
// reader's latency all degrade together, so new work waits rather than piling
// on. Well above normal traffic for this app, low enough to stay a ceiling.
const MAX_CONCURRENT_JOBS = 4;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_TRACKED_JOBS = 200;

const jobs = new Map<string, CompareJob>();

function prune(now: number) {
  for (const [threadId, job] of jobs) {
    const age = now - (job.finishedAt ?? job.startedAt);
    if (job.status !== "running" && age > JOB_TTL_MS) jobs.delete(threadId);
  }
  // Backstop: if finished jobs are somehow not aging out, drop the oldest
  // rather than letting the map grow without bound.
  if (jobs.size > MAX_TRACKED_JOBS) {
    const oldest = [...jobs.entries()]
      .filter(([, job]) => job.status !== "running")
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [threadId] of oldest.slice(0, jobs.size - MAX_TRACKED_JOBS)) jobs.delete(threadId);
  }
}

export function runningJobCount(): number {
  let count = 0;
  for (const job of jobs.values()) if (job.status === "running") count += 1;
  return count;
}

export function atCapacity(): boolean {
  return runningJobCount() >= MAX_CONCURRENT_JOBS;
}

export function getJob(threadId: string): CompareJob | null {
  return jobs.get(threadId) ?? null;
}

// Starts the workflow and returns immediately. `work` receives the progress
// callback to hand to the streaming graph entry point.
export function startJob(input: {
  threadId: string;
  query: string;
  work: (onProgress: (trace: RagGraphTraceEntry[]) => void) => Promise<RagStoredInstructorCompareRun>;
  onError?: (error: unknown) => void;
}): CompareJob {
  prune(Date.now());

  const job: CompareJob = {
    threadId: input.threadId,
    query: input.query,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    trace: [],
    result: null,
    error: null,
  };
  jobs.set(input.threadId, job);

  // Deliberately not awaited: the request returns while this keeps running.
  // Safe under `next start`, which is a persistent Node process, and the catch
  // means the promise can never reject unhandled.
  void input.work((trace) => { job.trace = trace; })
    .then((result) => {
      job.result = result;
      job.status = "complete";
      job.finishedAt = Date.now();
    })
    .catch((error: unknown) => {
      input.onError?.(error);
      job.error = error instanceof Error ? error.message : "The comparison failed.";
      job.status = "error";
      job.finishedAt = Date.now();
    });

  return job;
}

// Exposed for tests; the registry otherwise leaks state between cases.
export function resetCompareJobs() {
  jobs.clear();
}
