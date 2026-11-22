#!/usr/bin/env bash
# Page when vector retrieval stops working. Driven by launchd
# (local.zencub-rag-retrieval-canary) every 5 minutes.
#
# Calls /api/health/retrieval on the loopback MCP surface, which runs a real
# embedding and vector search. Two failures in a row page, so one network blip
# or a restart during a deploy stays quiet. An unreachable surface counts as a
# failure: a check that cannot run must never read as a check that passed.
#
# State file, one value per line:
#   consecutive failures / paged for this incident (0|1) / epoch of last page
#
# Exit codes: 0 healthy, 1 retrieval is failing.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${RETRIEVAL_CANARY_URL:-http://127.0.0.1:3421/api/health/retrieval}"
NOTIFY="${RETRIEVAL_CANARY_NOTIFY:-$SCRIPT_DIR/notify.sh}"
LOG_DIR="${RETRIEVAL_CANARY_LOG_DIR:-$HOME/Library/Logs/zencub-rag}"
STATE_FILE="$LOG_DIR/retrieval-canary.state"
FAILS_TO_PAGE=2
REMIND_AFTER=21600 # 6 hours

mkdir -p "$LOG_DIR"
stamp() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

read_line() {
  local value
  value="$(sed -n "$1p" "$STATE_FILE" 2>/dev/null)"
  case "$value" in ''|*[!0-9]*) echo 0 ;; *) echo "$value" ;; esac
}

fails="$(read_line 1)"
paged="$(read_line 2)"
last_page="$(read_line 3)"
now="$(date +%s)"

write_state() { printf '%s\n%s\n%s\n' "$1" "$2" "$3" >"$STATE_FILE"; }
field() { printf '%s' "$body" | sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p"; }

body="$(curl -sS --max-time 30 "$URL" 2>/dev/null)" || body=""

if printf '%s' "$body" | grep -q '"ok":true'; then
  if [ "$paged" = "1" ]; then
    if "$NOTIFY" "ZenCub vector search RECOVERED
canary returned $(field results) results in $(field duration_ms) ms" >/dev/null 2>&1; then
      stamp "recovered; page sent"
      write_state 0 0 0
    else
      # Keep the incident open so the next healthy run retries the all-clear.
      stamp "WARNING: recovered, but the recovery page could not be sent"
      write_state 0 1 "$last_page"
    fi
  else
    [ "$fails" -eq 0 ] || stamp "recovered after $fails failed check(s), below the page threshold"
    write_state 0 0 0
  fi
  exit 0
fi

fails=$((fails + 1))
if [ -n "$body" ]; then
  failure="$(field failure)"
  status="$(field upstream_status)"
  detail="${failure:-unexpected response}${status:+ (upstream $status)}"
else
  detail="canary unreachable (MCP surface on 3421 down?)"
fi
stamp "check failed ($fails in a row): $detail"

if [ "$fails" -ge "$FAILS_TO_PAGE" ] && { [ "$paged" = "0" ] || [ $((now - last_page)) -ge "$REMIND_AFTER" ]; }; then
  if "$NOTIFY" "ZenCub vector search FAILING
$detail, $fails checks in a row
Search is falling back to keyword-only, and /api/health will still say ok.
log: $LOG_DIR/retrieval-canary.log" >/dev/null 2>&1; then
    stamp "paged"
    paged=1
    last_page="$now"
  else
    # Not recorded as sent, so the next run retries instead of going quiet.
    stamp "WARNING: could not send the page"
  fi
fi

write_state "$fails" "$paged" "$last_page"
exit 1
