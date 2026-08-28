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
# A parked checkout is a normal development state, so it is reported once a day
# rather than at the failure cadence. Quiet enough to ignore for an afternoon,
# loud enough that it cannot be forgotten for a week.
PARKED_REMIND_AFTER=86400 # 24 hours

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
$(surface_summary)"
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
$(surface_summary)
log: $LOG_DIR/autodeploy.log"; then
    write_state fail "$now"
  else
    # The page did not land. Do not record it as sent, so the next run retries
    # rather than falling into the 6-hour quiet window on an alert nobody saw.
    write_state fail "$last"
  fi
}

# A checkout on a feature branch is a development state, not a broken deploy, and
# paging it as a failure every 6 hours would train the alert to be ignored. But
# it is not nothing either: deploys are paused while it lasts, and that is
# exactly what went unnoticed for an hour on 2026-08-28. So it gets its own
# quieter signal, once a day, that says what it is.
mark_parked() {
  local branch="$1"
  local prev last elapsed
  prev="$(read_state)"
  last="$(read_last_page)"
  [ -n "$last" ] || last=0
  elapsed=$(( now - last ))

  if [ "$prev" = "parked" ] && [ "$elapsed" -lt "$PARKED_REMIND_AFTER" ]; then
    stamp "parked on '$branch'; deploys paused, last notice ${elapsed}s ago"
    write_state parked "$last"
    return
  fi

  if page "zencub-rag autodeploy PARKED
checkout is on '$branch', not main, so deploys are paused.
This is not a failure. Nothing is being deployed until the branch merges or the
checkout returns to main.

origin/main: $(git rev-parse --short origin/main 2>/dev/null || echo unknown)
$(surface_summary)"; then
    write_state parked "$now"
  else
    write_state parked "$last"
  fi
}

port_sha() {
  curl -fsS --max-time 5 "http://127.0.0.1:$1/api/health" 2>/dev/null \
    | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p'
}

# Every surface, named, so an alert can say which one is down instead of "the
# deploy". 3419 answers 401 on /api/health by design -- its PIN gate fails
# closed -- so its liveness check is the unlock page.
#
# Every field is defaulted to the literal word "unreachable". A down surface
# rendering as an empty string is the whole failure mode this file exists to
# stop: the page would still be sent, and would read as though that surface had
# simply not been mentioned.
surface_summary() {
  local public instructors mcp demo
  public="$(port_sha 3418)" || public=""
  instructors="$(port_sha 3420)" || instructors=""
  mcp="$(port_sha 3421)" || mcp=""
  if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3419/unlock 2>/dev/null; then
    demo="serving"
  else
    demo="unreachable"
  fi
  printf 'public 3418: %s | instructors 3420: %s | mcp 3421: %s | demo 3419: %s' \
    "${public:-unreachable}" "${instructors:-unreachable}" "${mcp:-unreachable}" "$demo"
}

# Names the surfaces that are not on $1, empty when everything is current.
#
# This used to read 3418 alone, which made the other three invisible between
# deploys: mcp on 3421 could crash-loop indefinitely and autodeploy would keep
# writing "ok" because the public site was fine. 3421 is the one that matters
# most here, because it is the only surface nobody ever browses to, so a human
# would never notice it by accident.
surfaces_behind() {
  local want="$1" out=""
  [ "$(port_sha 3418)" = "$want" ] || out="$out public/3418"
  [ "$(port_sha 3420)" = "$want" ] || out="$out instructors/3420"
  [ "$(port_sha 3421)" = "$want" ] || out="$out mcp/3421"
  curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3419/unlock 2>/dev/null || out="$out demo/3419"
  echo "${out# }"
}

git fetch --quiet origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
branch="$(git rev-parse --abbrev-ref HEAD)"

# Checked here rather than left to deploy.sh's own guard, so the difference
# between "parked on a branch" and "the build broke" is decided before anything
# runs, and the two never share an alert.
if [ "$branch" != "main" ]; then
  mark_parked "$branch"
  exit 0
fi

if [ "$local_sha" = "$remote_sha" ]; then
  # A current checkout does not mean current servers: a build can fail after the
  # fast-forward already landed, which leaves git looking up to date while the
  # servers keep serving the old bundle. Compare what is actually running -- on
  # every surface, because a dead one is not visible in the checkout either.
  #
  # This is what makes a crash-looping surface reach a person. launchd restarts
  # it forever (KeepAlive, ThrottleInterval 15) and says nothing, so the loop is
  # silent by construction. Here it shows up as a surface behind the expected
  # sha, which triggers a redeploy; if it still will not come up, deploy.sh's
  # own per-surface verification fails and mark_fail pages. A surface that dies
  # once and restarts cleanly self-heals and is not paged, which is correct.
  behind="$(surfaces_behind "$(git rev-parse --short HEAD)")"
  if [ -z "$behind" ]; then
    mark_ok
    exit 0
  fi
  stamp "checkout is current but not live on $(git rev-parse --short HEAD): $behind; redeploying"
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
