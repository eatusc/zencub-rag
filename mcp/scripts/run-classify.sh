#!/usr/bin/env bash
# Run the content_kind classifier over the corpus with an alerting path, so a
# run that dies at 3am is not discovered at 9am by opening a log.
#
# Usage: mcp/scripts/run-classify.sh [extra args passed to the classifier]
#
# Three things can go wrong and all three must reach a person:
#   it fails      -> non-zero exit, paged with the tail of the log
#   it stalls     -> the watchdog pages when the log stops growing
#   it finishes   -> paged with the distribution, so success is also confirmed
#
# The classifier commits per video and resumes on content_kind IS NULL, so a
# killed run keeps everything it had already written and a re-run continues.
set -uo pipefail

cd "$(dirname "$0")/../.."

LOG_DIR="$HOME/Library/Logs/zencub-rag"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/classify-content-kind.log"
: > "$LOG"

# How long the log may go untouched before this is treated as a stall. The
# classifier writes a progress line every 25 videos, roughly once a minute, so
# 15 minutes is many missed beats rather than one slow model call.
STALL_SECONDS=900

page() { ./scripts/deploy/notify.sh "$1" >/dev/null 2>&1 || echo "WARNING: page failed: $1" >>"$LOG"; }

classified_count() {
  psql "$DSN" -tAc "SELECT count(content_kind) FROM public.rag_videos" 2>/dev/null || echo "?"
}

# Videos this script can actually classify. The old pages said "of 3032", the
# whole table, which includes ~187 videos with no transcript that are never
# candidates -- so a finished run would have read as stopping 187 short.
# In --verify-excludes mode the label count does not move -- labels are
# overwritten, not added -- so counting them would report a verify run as having
# done nothing. Count the second opinions instead.
verified_count() {
  psql "$DSN" -tAc "SELECT count(content_kind_verified_model) FROM public.rag_videos" 2>/dev/null || echo "?"
}

excluded_count() {
  psql "$DSN" -tAc "SELECT count(*) FROM public.rag_videos
                     WHERE content_kind IN ('event_coverage','no_content','off_topic')" 2>/dev/null || echo "?"
}

classifiable_count() {
  psql "$DSN" -tAc "SELECT count(DISTINCT v.video_id) FROM public.rag_videos v
                      JOIN public.rag_transcript_chunks c ON c.video_id = v.video_id" 2>/dev/null || echo "?"
}

DSN="$(python3 -c '
import re,sys
for line in open(".env.local"):
    m = re.match(r"^\s*LANGGRAPH_DATABASE_URL\s*=\s*(.*)$", line)
    if m:
        print(m.group(1).strip().strip("\"").strip("\x27")); break
')"
if [ -z "$DSN" ]; then
  echo "no LANGGRAPH_DATABASE_URL in .env.local" >&2
  exit 2
fi

# Which pass this is, so the pages describe what actually happened.
MODE="classify"
case " $* " in *" --verify-excludes "*) MODE="verify" ;; esac

CONTENT_KIND_MODEL="${CONTENT_KIND_MODEL:-anthropic/claude-haiku-4.5}" \
  node --experimental-strip-types mcp/scripts/classify-content-kind.ts "$@" >>"$LOG" 2>&1 &
RUN_PID=$!

# Watchdog. Deliberately a separate process watching the log's mtime rather than
# anything the run reports about itself: a hung process still claims to be fine
# by saying nothing, and silence is what this exists to catch.
(
  while kill -0 "$RUN_PID" 2>/dev/null; do
    sleep 60
    [ -f "$LOG" ] || continue
    age=$(( $(date +%s) - $(stat -f %m "$LOG") ))
    if [ "$age" -gt "$STALL_SECONDS" ]; then
      page "zencub-rag content_kind classify STALLED
no output for ${age}s (pid $RUN_PID still alive).
classified so far: $(classified_count) of $(classifiable_count) classifiable
log: $LOG"
      exit 0
    fi
  done
) &
WATCHDOG_PID=$!

wait "$RUN_PID"
status=$?
kill "$WATCHDOG_PID" 2>/dev/null

if [ "$status" -eq 0 ] && [ "$MODE" = "verify" ]; then
  page "zencub-rag content_kind VERIFY DONE
second opinions recorded: $(verified_count)
still excluded after verification: $(excluded_count) of $(classifiable_count)

$(grep -c '^  RESCUED' "$LOG" 2>/dev/null || echo 0) exclusions overturned and returned to the corpus:
$(grep '^  RESCUED' "$LOG" | head -12)"
elif [ "$status" -eq 0 ]; then
  page "zencub-rag content_kind classify DONE
classified: $(classified_count) of $(classifiable_count) classifiable

$(sed -n '/^distribution:/,$p' "$LOG" | head -12)"
else
  page "zencub-rag content_kind classify FAILED (exit $status)
classified before dying: $(classified_count) of $(classifiable_count) classifiable
The run commits per video, so this is kept and a re-run resumes on
content_kind IS NULL.

$(tail -n 12 "$LOG")"
fi

echo "classify finished with status $status; classified $(classified_count)"
exit "$status"
