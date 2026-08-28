#!/usr/bin/env bash
# Deploy when the running servers are behind origin/main. Driven by launchd
# (local.zencub-rag-autodeploy) every 5 minutes.
#
# Polling rather than a webhook: the Mac Studio is only reachable through the
# Cloudflare Tunnel, and opening an inbound deploy endpoint to the internet is a
# much larger surface than reading a remote ref every few minutes.
#
# Quiet when there is nothing to do, so the log is a list of real deploys.
#
# A quiet log is not proof of health, which is why failures page rather than
# only being written here. See notify.sh; the page is curl-only and shares no
# failure mode with the build it reports on.
set -euo pipefail

cd "$(dirname "$0")/../.."

LOG_DIR="$HOME/Library/Logs/zencub-rag"
STATE_FILE="$LOG_DIR/autodeploy.state"
# While a failure persists, re-page at most this often. A deploy that stays
# broken must not send 288 identical pages a day; one that goes quiet forever
# is the failure this whole mechanism exists to prevent, so it re-pages rather
# than alerting once and giving up.
REMIND_AFTER=21600 # 6 hours

stamp() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Never let the alerting path abort the deploy path.
page() {
  if ./scripts/deploy/notify.sh "$1" >/dev/null 2>&1; then
    return 0
  fi
  stamp "WARNING: could not send Telegram page; the alert below exists only in this log"
  stamp "$1"
  return 1
}

read_state() { sed -n '1p' "$STATE_FILE" 2>/dev/null || true; }
read_last_page() { sed -n '2p' "$STATE_FILE" 2>/dev/null || true; }

write_state() {
  mkdir -p "$LOG_DIR"
  printf '%s\n%s\n' "$1" "$2" >"$STATE_FILE"
}

now="$(date +%s)"

# Called on every path that ends healthy, including the quiet no-op exit, so a
# recovery is reported and the failure state cannot go stale.
mark_ok() {
  if [ "$(read_state)" = "fail" ]; then
    page "zencub-rag autodeploy RECOVERED
now on $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))
3418 reports: $(live_sha || echo unreachable)"
  fi
  write_state ok "$now"
}

mark_fail() {
  local detail="$1"
  local prev last elapsed
  prev="$(read_state)"
  last="$(read_last_page)"
  [ -n "$last" ] || last=0
  elapsed=$(( now - last ))

  if [ "$prev" = "fail" ] && [ "$elapsed" -lt "$REMIND_AFTER" ]; then
    # Still broken, already paged recently. Log only, keep the original
    # last-paged time so the reminder clock does not reset every 5 minutes.
    stamp "still failing; last page ${elapsed}s ago, next in $(( REMIND_AFTER - elapsed ))s"
    write_state fail "$last"
    return
  fi

  if page "zencub-rag autodeploy FAILED
$detail

branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)
origin/main: $(git rev-parse --short origin/main 2>/dev/null || echo unknown)
3418 reports: $(live_sha || echo unreachable)
log: $LOG_DIR/autodeploy.log"; then
    write_state fail "$now"
  else
    # The page did not land. Do not record it as sent, so the next run retries
    # rather than falling into the 6-hour quiet window on an alert nobody saw.
    write_state fail "$last"
  fi
}

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
    mark_ok
    exit 0
  fi
  stamp "checkout is current but 3418 reports '${live:-unreachable}'; redeploying"
else
  stamp "origin/main moved ${local_sha:0:7} -> ${remote_sha:0:7}; deploying"
fi

# Capture the deploy's own output so the page can say why it failed, while
# still writing everything to the log as before.
run_log="$(mktemp -t zencub-autodeploy)"
trap 'rm -f "$run_log"' EXIT

if ./scripts/deploy/deploy.sh 2>&1 | tee "$run_log"; then
  stamp "deploy ok, now on $(git rev-parse --short HEAD)"
  mark_ok
else
  status="${PIPESTATUS[0]}"
  # pipefail means a failed deploy cannot report 0 here, but exiting 0 on a
  # failure would tell launchd everything was fine, which is the exact signal
  # this file exists to stop being wrong about.
  [ "$status" -ne 0 ] || status=1
  stamp "deploy FAILED (exit $status); servers left on the previous build"
  mark_fail "deploy.sh exited $status; servers left on the previous build

$(tail -n 12 "$run_log")"
  exit "$status"
fi
