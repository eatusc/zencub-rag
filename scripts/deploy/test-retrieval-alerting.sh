#!/usr/bin/env bash
# Deterministic test of check-retrieval.sh's alerting state machine. Stubs curl
# and the notifier, so it sends nothing and touches no real server.
set -uo pipefail

ROOT="$(mktemp -d -t retrieval-canary-test)"
CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-retrieval.sh"
PASS=0; FAIL=0

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   - $1"
  else FAIL=$((FAIL+1)); echo "  FAIL - $1 (want '$3', got '$2')"; fi
}

mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/curl" <<'EOS'
#!/usr/bin/env bash
[ "$CURL_BODY" = "down" ] && exit 7
printf '%s' "$CURL_BODY"
EOS
cat > "$ROOT/notify" <<'EOS'
#!/usr/bin/env bash
[ "${NOTIFY_SHOULD_FAIL:-0}" = "1" ] && exit 5
printf '%s\n---\n' "$1" >> "$PAGES_FILE"
EOS
chmod +x "$ROOT/bin/curl" "$ROOT/notify"

export PATH="$ROOT/bin:$PATH"
export PAGES_FILE="$ROOT/pages"
export RETRIEVAL_CANARY_NOTIFY="$ROOT/notify"
export RETRIEVAL_CANARY_LOG_DIR="$ROOT/logs"
STATE="$ROOT/logs/retrieval-canary.state"
: > "$PAGES_FILE"

HEALTHY='{"ok":true,"results":12,"duration_ms":310}'
REVOKED='{"ok":false,"results":0,"duration_ms":120,"failure":"auth","upstream_status":401}'

pages() { grep -c -- '^---$' "$PAGES_FILE" | tr -d ' '; }
run() { CURL_BODY="$1" "$CHECK" >/dev/null 2>&1; }
reset() { rm -f "$STATE"; : > "$PAGES_FILE"; }

echo "== healthy is silent =="
run "$HEALTHY"; check "exit 0" "$?" "0"
check "no page" "$(pages)" "0"

echo "== one blip does not page =="
reset; run "$REVOKED"; check "exit 1" "$?" "1"
check "no page" "$(pages)" "0"
run "$HEALTHY"; check "still no page after recovery" "$(pages)" "0"
check "counter reset" "$(sed -n 1p "$STATE")" "0"

echo "== two failures page once, naming the cause =="
reset; run "$REVOKED"; run "$REVOKED"
check "one page" "$(pages)" "1"
grep -q "auth (upstream 401)" "$PAGES_FILE"; check "page names the cause" "$?" "0"
run "$REVOKED"; check "third failure stays quiet" "$(pages)" "1"

echo "== recovery pages once =="
run "$HEALTHY"; check "recovery page" "$(pages)" "2"
grep -q "RECOVERED" "$PAGES_FILE"; check "page says RECOVERED" "$?" "0"
run "$HEALTHY"; check "healthy again is silent" "$(pages)" "2"

echo "== a standing failure re-pages after 6 hours =="
reset; run "$REVOKED"; run "$REVOKED"
printf '5\n1\n%s\n' "$(( $(date +%s) - 21601 ))" > "$STATE"
run "$REVOKED"; check "reminder sent" "$(pages)" "2"

echo "== an unreachable canary counts as failing =="
reset; run down; run down
check "paged" "$(pages)" "1"
grep -q "unreachable" "$PAGES_FILE"; check "page says unreachable" "$?" "0"

echo "== an undelivered page is retried =="
reset; NOTIFY_SHOULD_FAIL=1 run "$REVOKED"; NOTIFY_SHOULD_FAIL=1 run "$REVOKED"
check "nothing delivered" "$(pages)" "0"
check "not recorded as paged" "$(sed -n 2p "$STATE")" "0"
run "$REVOKED"; check "next run delivers it" "$(pages)" "1"

echo "== an undelivered recovery is retried =="
reset; run "$REVOKED"; run "$REVOKED"
NOTIFY_SHOULD_FAIL=1 run "$HEALTHY"
check "incident stays open" "$(sed -n 2p "$STATE")" "1"
run "$HEALTHY"; check "recovery delivered" "$(pages)" "2"

echo
echo "$PASS passed, $FAIL failed"
rm -rf "$ROOT"
[ "$FAIL" -eq 0 ]
