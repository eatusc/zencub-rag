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

# curl stub: the surface probes must be deterministic, and this test must keep
# its promise to touch no real server. autodeploy calls curl unqualified, so a
# stub earlier on PATH intercepts every probe without autodeploy knowing.
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/curl" <<'EOS'
#!/usr/bin/env bash
# Reads $SURFACES_FILE: one "<port> <sha|down>" line per surface.
url=""
for arg in "$@"; do
  case "$arg" in http://*) url="$arg" ;; esac
done
port="${url#http://127.0.0.1:}"; port="${port%%/*}"
state="$(awk -v p="$port" '$1 == p { print $2 }' "$SURFACES_FILE" 2>/dev/null)"
[ -n "$state" ] || state=down
# 22 is what curl -f returns on an HTTP error; a refused connection is 7. Either
# way the caller only distinguishes zero from non-zero.
[ "$state" = "down" ] && exit 22
case "$url" in
  */api/health) echo "{\"ok\":true,\"build\":{\"sha\":\"$state\"}}" ;;
esac
exit 0
EOS
chmod +x "$ROOT/bin/curl"

export HOME="$ROOT/home"
export PAGES_FILE="$ROOT/pages.txt"
export PATH="$ROOT/bin:$PATH"
export SURFACES_FILE="$ROOT/surfaces"
STATE="$HOME/Library/Logs/zencub-rag/autodeploy.state"

# Put every surface on the current HEAD. Called after any commit, because the
# expected stamp is HEAD's short sha.
all_surfaces_current() {
  local sha; sha="$(git -C "$ROOT/repo" rev-parse --short HEAD)"
  printf '3418 %s\n3420 %s\n3421 %s\n3419 %s\n' "$sha" "$sha" "$sha" "$sha" > "$SURFACES_FILE"
}
all_surfaces_current

# Make HEAD differ from origin/main so the deploy path is always taken.
diverge() { echo "$RANDOM" > g; git add -A; git commit -qm "c$RANDOM"; }

# The opposite: make origin/main equal HEAD, so the steady-state health check is
# the path taken. Deliberately not `git reset --hard origin/main`, which rewinds
# the fake repo past the commits carrying the stub scripts and deletes them.
# The objects go over first under a scratch ref, because origin is a non-bare
# clone and will refuse a push to its checked-out branch.
converge() {
  git push -q origin "HEAD:refs/heads/mainsync" 2>/dev/null
  git -C "$ROOT/origin" update-ref refs/heads/main "$(git rev-parse HEAD)"
  git fetch -q origin main
}

# grep -c prints "0" AND exits 1 on an empty file, so the old `|| echo 0` here
# appended a second zero and every count read as "0\n0". Latent until a case
# asserted zero pages against a file that existed.
pages() { local n; n="$(grep -c -- '---' "$PAGES_FILE" 2>/dev/null)" || n=0; echo "${n:-0}"; }
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

# The cases above all diverge HEAD from origin/main, which takes the deploy
# path and never reaches the steady-state health check. That check is where a
# surface that dies BETWEEN deploys is caught, and until 2026-08-28 it read
# 3418 alone -- so mcp on 3421 could crash-loop forever while autodeploy wrote
# "ok" every five minutes.
echo "== 10. every surface current: no deploy, no page =="
git checkout -q main
converge
rm -f "$STATE"; : > "$PAGES_FILE"; : > "$ROOT/deploy-ran"
cat > scripts/deploy/deploy.sh <<'EOS'
#!/usr/bin/env bash
echo ran >> "$ROOT_MARK"
if [ "${DEPLOY_SHOULD_FAIL:-0}" = "1" ]; then
  echo "deployed, but mcp 3421 reports 'unreachable', not $(git rev-parse --short HEAD)" >&2
  exit 1
fi
EOS
chmod +x scripts/deploy/deploy.sh
all_surfaces_current
ROOT_MARK="$ROOT/deploy-ran" run
check "no page"                  "$(pages)"                  "0"
check "state is ok"              "$(sed -n 1p "$STATE")"     "ok"
check "deploy.sh not invoked"    "$(wc -l < "$ROOT/deploy-ran" | tr -d ' ')" "0"

echo "== 11. mcp 3421 down while the public site is fine: redeploys =="
: > "$ROOT/deploy-ran"
all_surfaces_current
sed -i '' 's/^3421 .*/3421 down/' "$SURFACES_FILE"
ROOT_MARK="$ROOT/deploy-ran" run
check "deploy.sh invoked"        "$(wc -l < "$ROOT/deploy-ran" | tr -d ' ')" "1"
check "still no page while it recovers" "$(pages)"           "0"

echo "== 12. mcp 3421 stays down: pages, and the page names it =="
: > "$ROOT/deploy-ran"
all_surfaces_current
sed -i '' 's/^3421 .*/3421 down/' "$SURFACES_FILE"
DEPLOY_SHOULD_FAIL=1 ROOT_MARK="$ROOT/deploy-ran" run
check "one page sent"            "$(pages)"                  "1"
check "state is fail"            "$(sed -n 1p "$STATE")"     "fail"
grep -q "mcp 3421: unreachable" "$PAGES_FILE" && ok "page names mcp 3421 as unreachable" || bad "page names mcp 3421 as unreachable"
grep -q "public 3418: " "$PAGES_FILE" && ok "page still reports the healthy surfaces" || bad "page still reports the healthy surfaces"
# The bug this replaces: an unreachable surface rendered as an empty string, so
# the page read as though it had simply not been mentioned.
grep -qE '(3418|3420|3421): \|' "$PAGES_FILE" && bad "a surface rendered blank instead of 'unreachable'" || ok "no surface renders blank"

echo
echo "$PASS passed, $FAIL failed"
rm -rf "$ROOT"
[ "$FAIL" -eq 0 ]
