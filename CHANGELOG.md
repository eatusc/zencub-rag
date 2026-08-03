# Changelog

Notable changes to this project. Routine fixes and refactors are not listed.

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
