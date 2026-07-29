# Deployment

Two public surfaces are served from this one codebase, both from the Mac Studio
through a Cloudflare Tunnel. Nothing about this changes the local dev server.

| Surface | Host | Port | `APP_MODE` | Build dir |
| --- | --- | --- | --- | --- |
| Public search | `search.zencub.com` | 3418 | `public` | `.next-public` |
| Full demo | `demo.zencub.com` | 3419 | `full` | `.next-demo` |
| Local dev | `mac-studio.rove-porgy.ts.net:3417` | 3417 | `full` | `.next` |

The dev server on 3417 is untouched by any of this: it keeps its own `.next`
directory, and the PIN gate is skipped outside `NODE_ENV=production`.

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

`APP_MODE=full` serves everything, behind a PIN.

## Abuse and cost controls

Layered, since the public host is anonymous:

| Control | Where | Default |
| --- | --- | --- |
| Per-IP ask limit | `src/lib/rateLimit.ts` | 10/min |
| Per-IP search limit | `src/lib/rateLimit.ts` | 60/min |
| Per-IP unlock attempts | `src/lib/rateLimit.ts` | 5 per 10 min |
| Site-wide daily ask budget | `RAG_PUBLIC_DAILY_ASK_BUDGET` | 2,000/day |
| Public answer model | `RAG_PUBLIC_ASK_PROVIDER` | `openrouter` |

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
launchctl kickstart -k gui/$(id -u)/local.zencub-rag-demo
```

`build.sh` builds twice, because `APP_MODE` is inlined into the middleware
bundle at build time and because the dev server keeps rewriting plain `.next`.

## First-time setup

Install the launchd agents (they restart on crash and at login):

```bash
mkdir -p ~/Library/Logs/zencub-rag
cp scripts/deploy/launchd/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.zencub-rag-public.plist
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
```

Then create the DNS records and restart the tunnel:

```bash
cloudflared tunnel route dns mac-studio-public search.zencub.com
cloudflared tunnel route dns mac-studio-public demo.zencub.com
launchctl kickstart -k gui/$(id -u)/local.mac-studio-public-cloudflared
```

`cloudflared tunnel route dns` needs the `zencub.com` account certificate at
`~/.cloudflared/cert.pem`; that path holds several accounts' certs under
different suffixes, so check it points at the zencub one first. Creating the
CNAMEs by hand in the Cloudflare dashboard works just as well.

Both servers bind to `127.0.0.1`, so the tunnel is the only way in: the ports
are not reachable over the LAN or Tailscale.
