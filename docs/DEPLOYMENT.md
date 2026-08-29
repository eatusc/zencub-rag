# Deployment

Three public surfaces are served from this one codebase through a Cloudflare
Tunnel, plus a fourth, loopback-only surface for MCP retrieval. Nothing about
this changes the local dev server.

| Surface | Host | Port | `APP_MODE` | Build dir |
| --- | --- | --- | --- | --- |
| Public search | `search.zencub.com` | 3418 | `public` | `.next-public` |
| Public compare | `instructors.zencub.com` | 3420 | `instructors` | `.next-instructors` |
| Full demo | `demo.zencub.com` | 3419 | `full` | `.next-demo` |
| MCP retrieval | loopback only, `127.0.0.1:3421` | 3421 | `mcp` | `.next-mcp` |
| Local dev | `mac-studio.rove-porgy.ts.net:3417` | 3417 | `full` | `.next` |

The mcp surface serves `/api/rag/retrieve` only (the app's real retrieval
pipeline, stopping before answer generation) for the [MCP server](../mcp/README.md);
it is deliberately never put behind the Cloudflare Tunnel. `deploy.sh` builds
and restarts all four surfaces and verifies all four came back on the new
commit.

The dev server on 3417 is untouched by any of this: it keeps its own `.next`
directory, and the PIN gate is skipped outside `NODE_ENV=production`.

## Deploying

```bash
./scripts/deploy/deploy.sh
```

That is the whole procedure: fast-forward `main`, build every surface, restart
them all, then block until the public and instructors surfaces report the new
commit. It refuses to
run on a branch other than `main` or with uncommitted changes, so a deploy can
never ship something that is not on `origin/main`, and never discards work in
progress to get there. `next-env.d.ts` is exempt from that check because every
build rewrites it.

A deploy holds `.deploy.lock` for its duration, so a hand-run deploy and the
scheduled one cannot build into the same directories at once. A lock left behind
by a killed deploy is reclaimed automatically once its process is gone.

Build and restart are one step on purpose. `build.sh` writes into
`.next-public`, `.next-instructors`, and `.next-demo` while the old servers are
still reading them, so
the gap between building and restarting is a window where a running server can
fail on a chunk that no longer matches its manifest. Running `build.sh` alone is
still supported for a build-only check; it now says plainly that the servers are
still on the old build.

### Knowing what is live

Every build stamps its commit into the bundle, and `/api/health` reports it:

```bash
curl -s http://127.0.0.1:3418/api/health   # public search
curl -s http://127.0.0.1:3420/api/health   # instructors
# {"ok":true,"build":{"sha":"0d694bf","built_at":"..."},"chunks":12104}
```

The stamp is captured at build time, not read from git at runtime. A server
reports the commit it was *built from*, which is the only number that can
reveal staleness. The build info is also returned on the 500 path, because
"which commit is live" gets asked precisely when something is broken.

Compare against the remote to check for drift:

```bash
git ls-remote origin main
```

The demo surface answers 401 on `/api/health` by design, since the PIN gate
fails closed. Its liveness check is `/unlock`.

### Automatic redeploy

`local.zencub-rag-autodeploy` runs `scripts/deploy/autodeploy.sh` every five
minutes. It deploys when `origin/main` has moved, and also when the checkout is
current but the running server reports a different commit, which is what a build
that failed after the fast-forward leaves behind. It exits silently when there
is nothing to do, so the log is a list of real deploys:

```bash
tail -f ~/Library/Logs/zencub-rag/autodeploy.log
```

Polling rather than a webhook: the Mac Studio is reachable only through the
Cloudflare Tunnel, and an inbound deploy endpoint is a much larger surface than
reading a remote ref. A push to `main` reaches production within five minutes,
so treat `main` as deployable. To pause it:

```bash
launchctl bootout gui/$(id -u)/local.zencub-rag-autodeploy
```

## What each surface exposes

`APP_MODE=public` renders `PublicSearch` instead of the six-tab `SearchClient`,
and `src/middleware.ts` answers 404 for every `/api` path outside this list:

- `/api/rag/search` (Postgres full-text)
- `/api/rag/vector-search` (pgvector semantic)
- `/api/rag/ask` (cited answers)
- `/api/health`

So the LangGraph, Instructor Compare, provider-probe, and Langfuse routes are
unreachable on the public host rather than merely hidden from the UI. The public
deployment also pins `LANGGRAPH_TEST_MODE=off` and ignores any `provider` in an
Ask request body, because `claude` spawns a CLI process per call and `openai`
spends money.

`APP_MODE=instructors` renders `InstructorsApp` and allows only:

- `/api/instructors/compare` (start a comparison, poll a running one)
- `/api/instructors/runs` (recent comparisons, and one by id)
- `/api/health`

Page paths are limited to `/` and `/c/<uuid>`; anything else redirects home.
The demo's own `/api/rag/instructor-compare` is **not** exposed here, because
that route accepts a caller-chosen provider and a test-mode failure slug. This
surface pins the provider and the model server-side in `serve.sh`, fixes the
panel size (`RAG_INSTRUCTORS_PANEL_SIZE`, default 5), and has no test-mode
surface at all.

The panel is five rather than three because the corpus supports it. Measured
across three topics on gpt-4o-mini, every five-instructor panel filled
completely, all three scored 100% on claim verification against 67% for a
three-instructor run of the same question, and evidence rose from 4-6 clips to
6-8. Latency did not move (20-36s), because the analysis branches fan out in
parallel: a wider panel is two more concurrent calls, not two more sequential
ones. Cost per run goes from roughly $0.006 to $0.008.

`APP_MODE=full` serves everything, behind a PIN. It also pins
`LANGGRAPH_TEST_MODE=off`: without that it inherits `on` from `.env.local`,
which is what a PIN holder would need to inject failures into live graphs,
replay checkpoints, and write rows through `/api/rag/graph-note`.

## The comparison workflow as a public app

`instructors.zencub.com` runs the same checkpointed LangGraph workflow the demo
runs, with two differences that matter in production.

**It does not answer in one request.** A comparison takes roughly 30 seconds on
gpt-4o-mini and was measured at 114 seconds on Qwen3 235B, while Cloudflare cuts
an origin response off at 100 seconds and returns 524. So `POST` starts the
workflow as a background job and returns a `thread_id`; the browser polls `GET`
about once a second. `src/lib/instructorCompareJobs.ts` holds the live view in
process, capped at four concurrent runs. The durable copies are the LangGraph
checkpoint and the stored run row, so a restart mid-run costs a spinner rather
than a result.

**The poll is the interface.** `runInstructorComparisonStreamed` streams graph
state after every superstep, and the trace channel is append-only, so each poll
returns every node that has finished. The UI draws retrieval fanning out, one
analysis branch per instructor, those branches converging into a single
synthesis, and each claim being verified on its own. Nothing about that display
is scripted; the node ids come from the execution.

Follow-ups run on the same thread, so turn two reuses the approved panel out of
the checkpoint instead of retrieving from scratch. That needs the capability
token minted when the thread was created, which is why a `thread_id` alone gets
a 403.

Finished runs are stored in `rag_instructor_compare_runs` with
`result->>surface = 'instructors'`. The listing and the permalink both filter on
that, so nothing typed into the internal demo can appear on the public site.

## Abuse and cost controls

Layered, since the public host is anonymous:

| Control | Where | Default |
| --- | --- | --- |
| Per-IP ask limit | `src/lib/rateLimit.ts` | 10/min |
| Per-IP search limit | `src/lib/rateLimit.ts` | 60/min |
| Per-IP unlock attempts | `src/lib/rateLimit.ts` | 5 per 10 min |
| Per-IP comparison limit | `src/lib/rateLimit.ts` | 5 per 10 min |
| Concurrent comparisons | `src/lib/instructorCompareJobs.ts` | 4 |
| Site-wide daily ask budget | `RAG_PUBLIC_DAILY_ASK_BUDGET` | 2,000/day |
| Site-wide daily comparison budget | `RAG_INSTRUCTORS_DAILY_BUDGET` | 500/day |
| Public answer model | `RAG_PUBLIC_ASK_PROVIDER` | `openrouter` |
| Public comparison model | `RAG_INSTRUCTORS_PROVIDER` | `openai` (gpt-4o-mini) |
| Instructors per panel | `RAG_INSTRUCTORS_PANEL_SIZE` | 5 (clamped 2-5) |

The per-IP comparison limit also applies to the demo's workflow routes
(`/api/rag/instructor-compare`, `/api/rag/graph-ask`, `/api/rag/graph-follow-up`).
Before that, the PIN was the only thing between a shared demo link and
unbounded model spend.

A comparison is about a dozen model calls, measured at 27.5k input and 3k output
tokens, so roughly $0.008 on gpt-4o-mini at a five-instructor panel. The
500/day ceiling is about $4/day.
When it trips, the page says so plainly.

In-process counters are sufficient here because each surface is a single
long-lived `next start` process, not serverless functions. Per-IP limits alone
do not bound spend (a botnet is many IPs), so the daily budget is the number
that actually caps the bill. When it trips, Ask returns 429 and search keeps
working.

The budget is sized for follow-up threads rather than one-shot questions. A
follow-up runs the same retrieval, rerank, and generation as an opening
question, so a single reader working a thread to the 6-turn cap spends 6 of the
daily allowance. At roughly $0.001 a call the ceiling is about $2/day.

`RAG_PUBLIC_ASK_PROVIDER=qwen` answers locally for free but takes roughly 45
seconds per answer. `openrouter` answers in about 8 seconds for roughly $0.001
per call. Add a Cloudflare WAF rate-limiting rule on `/api/rag/ask` in front of
all of this.

## Public search outcome metrics

Keyword, semantic, Ask, and public follow-up requests store completed outcomes
in `rag_search_logs.metadata`. The `provider` and `retrieval` columns describe
what actually ran; requested values remain in metadata so fallbacks are
visible. The initial production signals are:

- success/error rate (`success`, `status_code`, `error_code`)
- result and zero-result rate (`result_count`)
- end-to-end route latency (`duration_ms`)
- provider fallback (`resolved_provider` is the provider chosen before any
  fallback, including an auto-detected one; `provider_fallback` is true when a
  different provider ended up answering)
- citation validation (`citation_requested_count`,
  `citation_verified_count`, `citation_rejected_count`,
  `citation_truncated_count`, `citation_missing`, and
  `citation_validation_failed`)

A row is written when a request finishes, so these rates have a denominator of
requests that reached the route and ran. Queries under two characters cannot be
logged at all, because `rag_search_logs.query` requires two, and requests turned
away by the middleware rate limiter never reach the route; count those at the
Cloudflare WAF instead. `citation_truncated_count` is not a failure: those
citations were verified and then dropped at the three-citation display cap.

Example daily rollup:

```sql
select
  date_trunc('day', created_at) as day,
  count(*) as requests,
  avg((metadata->>'success')::boolean::int) as success_rate,
  avg(((metadata->>'result_count')::int = 0)::int) as zero_result_rate,
  percentile_cont(0.5) within group (
    order by (metadata->>'duration_ms')::int
  ) as p50_ms,
  percentile_cont(0.95) within group (
    order by (metadata->>'duration_ms')::int
  ) as p95_ms,
  avg(coalesce((metadata->>'citation_validation_failed')::boolean::int, 0))
    filter (where action in ('ask', 'follow_up')) as citation_failure_rate
from public.rag_search_logs
where metadata ? 'success'
group by 1
order by 1 desc;
```

## Secrets

Shared secrets stay in `.env.local`, which Next loads on its own. `serve.sh`
exports only per-deployment overrides, and real process env always beats Next's
`.env` files.

The demo PIN lives in `scripts/deploy/prod.env` (gitignored, `chmod 600`):

```bash
cp scripts/deploy/prod.env.example scripts/deploy/prod.env
# DEMO_PIN=<the PIN you hand out>
# DEMO_SECRET=$(openssl rand -hex 32)
```

Both must be set or the demo deployment fails closed with a 503. The unlock
cookie is an HMAC-signed expiry stamp with a 12-hour life, so no session state
is stored server-side and rotating `DEMO_SECRET` logs everyone out.

`RAG_COMPARE_MAX_REFINEMENT_ROUNDS` controls the total targeted-retrieval
budget shared by both Instructor Compare loop-back gates. It is clamped to
`0-3`; the recommended demo value is `2`.

Each repair round rebuilds the panel and re-runs every per-instructor analysis,
the synthesis, and all claim verifications, because the branch recovery cache is
keyed by round. Raising the budget raises model spend in step. In guided mode a
loop-back from the final quality gate also passes through the human review pause
again, so one run can ask for panel approval more than once; clips removed in an
earlier review stay removed. Setting the budget to `0` disables repair entirely,
which also means a panel with fewer than two attributed instructors fails
immediately instead of getting a targeted-retrieval attempt.

## Deploying a change

```bash
npm run typecheck && npm run lint && npm test
./scripts/deploy/build.sh
launchctl kickstart -k gui/$(id -u)/local.zencub-rag-public
launchctl kickstart -k gui/$(id -u)/local.zencub-rag-instructors
launchctl kickstart -k gui/$(id -u)/local.zencub-rag-demo
```

`build.sh` builds three times, because `APP_MODE` is inlined into the middleware
bundle at build time and because the dev server keeps rewriting plain `.next`.

## First-time setup

Install the launchd agents (they restart on crash and at login):

```bash
mkdir -p ~/Library/Logs/zencub-rag
cp scripts/deploy/launchd/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.zencub-rag-public.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.zencub-rag-instructors.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.zencub-rag-demo.plist
```

Logs land in `~/Library/Logs/zencub-rag/`.

Both hosts ride the existing `mac-studio-public` tunnel, which already serves
the `zencub.com` zone. Add to `~/.config/cloudflared/mac-studio-public.yml`
above the catch-all:

```yaml
  - hostname: search.zencub.com
    service: http://127.0.0.1:3418
  - hostname: demo.zencub.com
    service: http://127.0.0.1:3419
  - hostname: instructors.zencub.com
    service: http://127.0.0.1:3420
```

Then create the DNS records and restart the tunnel:

```bash
~/.cloudflared/route-dns mac-studio-public search.zencub.com
~/.cloudflared/route-dns mac-studio-public demo.zencub.com
~/.cloudflared/route-dns mac-studio-public instructors.zencub.com
launchctl kickstart -k gui/$(id -u)/local.mac-studio-public-cloudflared
```

Use the `route-dns` wrapper, not `cloudflared tunnel route dns` directly. The
raw command uses whichever `~/.cloudflared/cert.pem` is active, and when the
hostname is not in that cert's zone it does not fail: it creates
`instructors.zencub.com.helpaproduct.com` instead, which can never serve traffic
because Cloudflare's universal certificate covers only one level of subdomain.
The wrapper resolves each cert to its real zone and picks the right one. See
`~/.cloudflared/README.md`.

Both servers bind to `127.0.0.1`, so the tunnel is the only way in: the ports
are not reachable over the LAN or Tailscale.
