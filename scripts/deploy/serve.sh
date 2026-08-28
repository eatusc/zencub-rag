#!/usr/bin/env bash
# Start one production surface. Usage: serve.sh <public|instructors|demo|mcp>
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
  instructors)
    export APP_MODE=instructors
    export NEXT_DIST_DIR=.next-instructors
    export PORT=3420
    # Public host, so the same rule as search: no LangGraph test surface.
    export LANGGRAPH_TEST_MODE=off
    # Pinned rather than inherited. The workflow is a dozen model calls, so
    # local Qwen would hold the machine's only Ollama instance for about ten
    # minutes per comparison, and the model this site is priced around is
    # gpt-4o-mini. Both are set here so a change to .env.local cannot quietly
    # re-point the public app at a different model or a different bill.
    export RAG_INSTRUCTORS_PROVIDER="${RAG_INSTRUCTORS_PROVIDER:-openai}"
    export RAG_ANSWER_MODEL="${RAG_ANSWER_MODEL:-gpt-4o-mini}"
    export RAG_RERANK_MODEL="${RAG_RERANK_MODEL:-gpt-4o-mini}"
    # Site-wide ceiling on comparisons per day. At roughly $0.006 a run this is
    # about $3/day. When it trips, the page says so rather than failing oddly.
    export RAG_INSTRUCTORS_DAILY_BUDGET="${RAG_INSTRUCTORS_DAILY_BUDGET:-500}"
    # Two targeted-retrieval rounds is the demo value; the public app is
    # latency-sensitive and the gate now stops on its own when a round achieves
    # nothing, so this only bounds the worst case.
    export RAG_COMPARE_MAX_REFINEMENT_ROUNDS="${RAG_COMPARE_MAX_REFINEMENT_ROUNDS:-2}"
    ;;
  mcp)
    export APP_MODE=mcp
    export NEXT_DIST_DIR=.next-mcp
    export PORT=3421
    # Retrieval only: this surface serves /api/health and /api/rag/retrieve and
    # 404s everything else, including every page. It is bound to loopback and
    # has no Cloudflare Tunnel in front of it, which is what keeps it private --
    # not a header check, because clientIp() reads caller-supplied headers.
    export LANGGRAPH_TEST_MODE=off
    # No answer generation happens here, so there is no ask budget to set. The
    # deliberate absence is the point: /api/rag/ask consumes search.zencub.com's
    # daily allowance in middleware before the handler runs, which is exactly
    # why MCP retrieval is not served from that route.
    ;;
  demo)
    export APP_MODE=full
    export NEXT_DIST_DIR=.next-demo
    export PORT=3419
    # The demo is a tunnelled public host, not a test rig. Without this it
    # inherits LANGGRAPH_TEST_MODE=on from .env.local, which is what a PIN
    # holder needs to inject failures, replay checkpoints, and write notes.
    export LANGGRAPH_TEST_MODE=off
    # DEMO_PIN and DEMO_SECRET live here; without them the demo fails closed.
    if [ -f scripts/deploy/prod.env ]; then
      set -a
      # shellcheck disable=SC1091
      . ./scripts/deploy/prod.env
      set +a
    fi
    ;;
  *)
    echo "usage: $0 <public|instructors|demo>" >&2
    exit 64
    ;;
esac

# Bind to loopback only: the sole path in is the Cloudflare Tunnel, so these
# ports are not reachable from the LAN or over Tailscale.
exec ./node_modules/.bin/next start -H 127.0.0.1 -p "$PORT"
