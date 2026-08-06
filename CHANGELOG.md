# Changelog

Notable changes to this project. Routine fixes and refactors are not listed.

## 2026-08-05

### Added
- Public Instructor Compare app at [instructors.zencub.com](https://instructors.zencub.com): a third deployment surface (`APP_MODE=instructors`, port 3420) running the same checkpointed LangGraph workflow as one question and one button, on gpt-4o-mini pinned server-side. The workflow runs as a background job and the browser polls the graph trace, so the live progress display is the real execution: retrieval fanning out, one analysis branch per instructor, those branches converging into a synthesis, then each claim verified on its own. Includes same-thread follow-ups that reuse the approved panel out of the checkpoint, shareable `/c/<id>` permalinks for stored runs, and a recent-comparisons strip.
- Per-IP comparison rate limit and a site-wide daily comparison budget (`RAG_INSTRUCTORS_DAILY_BUDGET`, default 500/day), plus a concurrency cap of four in-flight workflows. The per-IP limit now also covers the demo's workflow routes, which previously had the PIN as their only protection against unbounded model spend.

### Fixed
- `LANGGRAPH_TEST_MODE` was inherited as `on` from `.env.local` by the production demo deployment, which left failure injection, checkpoint replay, and note writes reachable to any PIN holder. `serve.sh` now pins it off for every deployed surface.
- The Instructor Compare evidence gate spent its entire refinement budget on every run, re-ranking its way back to the same panel. A round now has to close a gap to earn the next one, which removed a full rerank pass (31 seconds of a measured 114-second run) from the common case.
- Model calls had no timeout, so a hung provider held the request, its checkpoint, and a socket open indefinitely. All OpenAI-compatible clients now come from one factory with an explicit timeout.
- Workflow errors returned raw exception text to the browser, including Supabase messages and table names. They are now logged server-side and reported generically.
- The synthesis step's decision guide came back empty on most gpt-4o-mini runs, because the model returned objects where the parser only accepted strings.

## 2026-08-01

### Added
- Stored quality reviews (Instructor Compare comparisons) can now be printed to PDF from the comparison modal, capturing metrics, quality gates, per-stage model calls, the graph trace, and per-claim verdicts.

## 2026-07-28

### Added
- Public, anonymous search deployment at [search.zencub.com](https://search.zencub.com) (transcript search plus cited Ask, with per-IP rate limits and a site-wide daily ask budget) alongside the existing PIN-gated full demo at [demo.zencub.com](https://demo.zencub.com). Both are served from one codebase; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- A stored research thread can now be resumed and continued from the run explorer, not just viewed.

### Changed
- The assistant now declines off-topic questions instead of answering them from the nearest (but irrelevant) retrieved clips.
- Deploys are now atomic and self-healing: `deploy.sh` builds and restarts both surfaces as one locked step, `/api/health` reports the build's commit and build time, and the `local.zencub-rag-autodeploy` job redeploys automatically whenever the running server drifts from `origin/main`.

## 2026-07-20

### Added
- Self-hosted Langfuse tracing: LangGraph runs are now traced to a self-hosted Langfuse instance, viewable in a new Langfuse tab in the app (latency, cost, node tree).
