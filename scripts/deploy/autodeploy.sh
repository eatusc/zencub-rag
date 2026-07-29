#!/usr/bin/env bash
# Deploy when the running servers are behind origin/main. Driven by launchd
# (local.zencub-rag-autodeploy) every 5 minutes.
#
# Polling rather than a webhook: the Mac Studio is only reachable through the
# Cloudflare Tunnel, and opening an inbound deploy endpoint to the internet is a
# much larger surface than reading a remote ref every few minutes.
#
# Quiet when there is nothing to do, so the log is a list of real deploys.
set -euo pipefail

cd "$(dirname "$0")/../.."

stamp() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

live_sha() {
  curl -fsS --max-time 5 http://127.0.0.1:3418/api/health 2>/dev/null \
    | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p'
}

git fetch --quiet origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"

if [ "$local_sha" = "$remote_sha" ]; then
  # A current checkout does not mean current servers: a build can fail after the
  # fast-forward already landed, which leaves git looking up to date while the
  # servers keep serving the old bundle. Compare what is actually running.
  live="$(live_sha)" || live=""
  if [ "$live" = "$(git rev-parse --short HEAD)" ]; then
    exit 0
  fi
  stamp "checkout is current but 3418 reports '${live:-unreachable}'; redeploying"
else
  stamp "origin/main moved ${local_sha:0:7} -> ${remote_sha:0:7}; deploying"
fi

if ./scripts/deploy/deploy.sh; then
  stamp "deploy ok, now on $(git rev-parse --short HEAD)"
else
  status=$?
  stamp "deploy FAILED (exit $status); servers left on the previous build"
  exit "$status"
fi
