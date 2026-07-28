#!/usr/bin/env bash
# Start one production surface. Usage: serve.sh <public|demo>
#
# Secrets still come from .env.local, which Next loads on its own. This script
# only exports the per-deployment overrides, and real process env always wins
# over Next's .env files.
set -euo pipefail

MODE="${1:-}"
cd "$(dirname "$0")/../.."

case "$MODE" in
  public)
    export APP_MODE=public
    export NEXT_DIST_DIR=.next-public
    export PORT=3418
    # The public surface never runs LangGraph writes, recovery, or replay.
    # .env.local sets this to `on` for local testing; override it here.
    export LANGGRAPH_TEST_MODE=off
    # Local Qwen answers for free but takes ~45s; OpenRouter answers in ~8s for
    # roughly $0.001 a call. Set to `qwen` to trade latency back for zero cost.
    export RAG_PUBLIC_ASK_PROVIDER="${RAG_PUBLIC_ASK_PROVIDER:-openrouter}"
    # Site-wide ceiling on answer generation per day. Search stays up when hit.
    # Sized for follow-up threads: each turn is a full retrieval + generation,
    # so one reader can spend 6. Roughly $2/day at OpenRouter prices.
    export RAG_PUBLIC_DAILY_ASK_BUDGET="${RAG_PUBLIC_DAILY_ASK_BUDGET:-2000}"
    ;;
  demo)
    export APP_MODE=full
    export NEXT_DIST_DIR=.next-demo
    export PORT=3419
    # DEMO_PIN and DEMO_SECRET live here; without them the demo fails closed.
    if [ -f scripts/deploy/prod.env ]; then
      set -a
      # shellcheck disable=SC1091
      . ./scripts/deploy/prod.env
      set +a
    fi
    ;;
  *)
    echo "usage: $0 <public|demo>" >&2
    exit 64
    ;;
esac

# Bind to loopback only: the sole path in is the Cloudflare Tunnel, so these
# ports are not reachable from the LAN or over Tailscale.
exec ./node_modules/.bin/next start -H 127.0.0.1 -p "$PORT"
