#!/usr/bin/env bash
# Page Eric over Cladia's Telegram bot. Usage:
#   notify.sh "message body"
#   echo "message body" | notify.sh
#
# Deliberately curl-only: no node, no python, no model, no dependency on the app
# or the database. The alerting path must not share a failure mode with the
# thing it reports on, and a deploy alert that needs a working build to send is
# useless exactly when it is needed.
#
# Credentials: ~/code/cladia/.env, keys CLADIA_BOT_TOKEN and
# CLADIA_ALLOWED_USERS. This is the same pair sys_docs/scripts/jobs_audit.py
# sends through, chosen so there is one live outbound path on this machine
# rather than a second one that can rot unnoticed.
#
# NOT ~/.hermes/.env: every TELEGRAM_* line in that file is commented out, so
# anything sourcing it silently gets an unset token and sends nothing. Verified
# 2026-08-28. amzdash/scripts/notify-telegram.sh still reads it and is broken
# for that reason.
#
# This repository is public: no token, chat id, or env contents are ever echoed
# by this script, including in its error paths.
#
# Exits non-zero if it could not send, so a caller can log that the page itself
# failed rather than assuming it landed.
set -uo pipefail

ENV_FILE="$HOME/code/cladia/.env"
if [ ! -r "$ENV_FILE" ]; then
  echo "notify: $ENV_FILE not readable; cannot page" >&2
  exit 2
fi

# Read the two keys directly rather than sourcing. The file is a plain env file,
# but sourcing an unknown file executes whatever is in it, and one stray line
# elsewhere on this machine already proved that (a Chrome path in ~/.hermes/.env
# errors on source).
TOKEN="$(sed -n 's/^CLADIA_BOT_TOKEN=//p' "$ENV_FILE" | head -1 | tr -d '"'"'"' \r')"
CHAT="$(sed -n 's/^CLADIA_ALLOWED_USERS=//p' "$ENV_FILE" | head -1 | tr -d '"'"'"' \r' | cut -d, -f1)"

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "notify: CLADIA_BOT_TOKEN or CLADIA_ALLOWED_USERS missing from $ENV_FILE" >&2
  exit 3
fi

if [ "$#" -ge 1 ]; then
  MSG="$1"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "notify: empty message, refusing to send" >&2
  exit 4
fi

out="$(mktemp -t zencub-notify)"
trap 'rm -f "$out"' EXIT

status="$(curl -sS -o "$out" -w '%{http_code}' --max-time 15 \
  -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT}" \
  --data-urlencode "text=${MSG}" \
  -d "disable_web_page_preview=true")" || status="000"

if [ "$status" != "200" ]; then
  # Telegram echoes the request back on some errors, so the body is not printed.
  # The status code is enough to tell a bad token from a bad chat id from a
  # network failure, and it cannot leak the token into a log.
  echo "notify: Telegram returned HTTP $status" >&2
  exit 5
fi
