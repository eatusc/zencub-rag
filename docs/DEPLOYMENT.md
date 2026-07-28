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
