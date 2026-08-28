#!/usr/bin/env bash
# Deterministic test of autodeploy.sh's alerting state machine.
# Builds a throwaway git repo, stubs deploy.sh and notify.sh, and asserts on the
# pages that would have been sent. Sends nothing and touches no real surface.
set -uo pipefail

ROOT="$(mktemp -d -t autodeploy-test)"
REAL_AUTODEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/autodeploy.sh"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# --- fake repo -------------------------------------------------------------
mkdir -p "$ROOT/repo/scripts/deploy" "$ROOT/home/Library/Logs/zencub-rag"
cd "$ROOT/repo"
git init -q . && git config user.email t@t && git config user.name t
echo x > f && git add -A && git commit -qm one
git branch -q -M main
git clone -q . "$ROOT/origin" 2>/dev/null
git remote add origin "$ROOT/origin" 2>/dev/null
git fetch -q origin main

cp "$REAL_AUTODEPLOY" scripts/deploy/autodeploy.sh
chmod +x scripts/deploy/autodeploy.sh

# notify stub: records every page instead of sending one
cat > scripts/deploy/notify.sh <<'EOS'
#!/usr/bin/env bash
if [ "${NOTIFY_SHOULD_FAIL:-0}" = "1" ]; then exit 5; fi
printf '%s\n---\n' "$1" >> "$PAGES_FILE"
EOS
chmod +x scripts/deploy/notify.sh

# deploy stub: succeeds or fails on demand
cat > scripts/deploy/deploy.sh <<'EOS'
#!/usr/bin/env bash
echo "==> Building public surface"
if [ "${DEPLOY_SHOULD_FAIL:-0}" = "1" ]; then
  echo "refusing to deploy: on 'mcp-server', not main" >&2
  exit 1
fi
echo "==> Built."
EOS
chmod +x scripts/deploy/deploy.sh

export HOME="$ROOT/home"
export PAGES_FILE="$ROOT/pages.txt"
STATE="$HOME/Library/Logs/zencub-rag/autodeploy.state"

# Make HEAD differ from origin/main so the deploy path is always taken.
diverge() { echo "$RANDOM" > g; git add -A; git commit -qm "c$RANDOM"; }

pages() { grep -c -- '---' "$PAGES_FILE" 2>/dev/null || echo 0; }
run() { ( cd "$ROOT/repo" && ./scripts/deploy/autodeploy.sh >/dev/null 2>&1 ); }

echo "== 1. first failure pages immediately =="
diverge; DEPLOY_SHOULD_FAIL=1 run
check "one page sent"            "$(pages)"                  "1"
check "state is fail"            "$(sed -n 1p "$STATE")"     "fail"
grep -q "autodeploy FAILED" "$PAGES_FILE" && ok "page says FAILED" || bad "page says FAILED"
grep -q "refusing to deploy" "$PAGES_FILE" && ok "page carries the reason" || bad "page carries the reason"

echo "== 2. repeat failure inside the window does NOT page again =="
first_stamp="$(sed -n 2p "$STATE")"
diverge; DEPLOY_SHOULD_FAIL=1 run
check "still one page"           "$(pages)"                  "1"
check "last-paged clock did not reset" "$(sed -n 2p "$STATE")" "$first_stamp"

echo "== 3. recovery pages once, then goes quiet =="
diverge; DEPLOY_SHOULD_FAIL=0 run
check "recovery page sent"       "$(pages)"                  "2"
check "state is ok"              "$(sed -n 1p "$STATE")"     "ok"
grep -q "RECOVERED" "$PAGES_FILE" && ok "page says RECOVERED" || bad "page says RECOVERED"
diverge; DEPLOY_SHOULD_FAIL=0 run
check "healthy run is silent"    "$(pages)"                  "2"

echo "== 4. an unsendable page is not recorded as sent =="
rm -f "$STATE"
diverge; DEPLOY_SHOULD_FAIL=1 NOTIFY_SHOULD_FAIL=1 run
check "nothing recorded"         "$(pages)"                  "2"
check "state is fail"            "$(sed -n 1p "$STATE")"     "fail"
check "last-paged stays 0"       "$(sed -n 2p "$STATE")"     "0"
diverge; DEPLOY_SHOULD_FAIL=1 run
check "next run retries the page" "$(pages)"                 "3"

echo "== 5. a feature branch is parked, not failed =="
rm -f "$STATE"; : > "$PAGES_FILE"
git checkout -q -b feature-x
diverge; run
check "one page sent"            "$(pages)"                  "1"
check "state is parked"          "$(sed -n 1p "$STATE")"     "parked"
grep -q "PARKED" "$PAGES_FILE" && ok "page says PARKED" || bad "page says PARKED"
grep -q "FAILED" "$PAGES_FILE" && bad "parked page must not say FAILED" || ok "parked is never reported as a failure"
grep -q "feature-x" "$PAGES_FILE" && ok "page names the branch" || bad "page names the branch"

echo "== 6. parked does not re-page at the failure cadence =="
diverge; run
check "still one page"           "$(pages)"                  "1"
check "state stays parked"       "$(sed -n 1p "$STATE")"     "parked"

echo "== 7. returning to main resumes deploys without a recovery page =="
git checkout -q main
diverge; DEPLOY_SHOULD_FAIL=0 run
check "no extra page"            "$(pages)"                  "1"
check "state is ok"              "$(sed -n 1p "$STATE")"     "ok"

echo "== 8. a parked checkout never runs deploy.sh =="
git checkout -q feature-x
rm -f "$STATE"; : > "$PAGES_FILE"; : > "$ROOT/deploy-ran"
cat > scripts/deploy/deploy.sh <<'EOS'
#!/usr/bin/env bash
echo ran >> "$ROOT_MARK"
EOS
chmod +x scripts/deploy/deploy.sh
diverge; ROOT_MARK="$ROOT/deploy-ran" run
check "deploy.sh not invoked"    "$(wc -l < "$ROOT/deploy-ran" | tr -d ' ')" "0"
git checkout -q main

echo "== 9. failure exit code reaches launchd =="
cat > scripts/deploy/deploy.sh <<'EOS'
#!/usr/bin/env bash
echo "==> Building public surface"
if [ "${DEPLOY_SHOULD_FAIL:-0}" = "1" ]; then
  echo "refusing to deploy: something broke" >&2
  exit 1
fi
echo "==> Built."
EOS
chmod +x scripts/deploy/deploy.sh
diverge
( cd "$ROOT/repo" && DEPLOY_SHOULD_FAIL=1 ./scripts/deploy/autodeploy.sh >/dev/null 2>&1 )
check "exit code non-zero"       "$?"                        "1"

echo
echo "$PASS passed, $FAIL failed"
rm -rf "$ROOT"
[ "$FAIL" -eq 0 ]
