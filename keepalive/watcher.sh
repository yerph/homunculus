#!/bin/bash
# Watcher script — checks for a scheduled wakeup time and sends nudge
#
# Claude Code writes a unix timestamp to WAKEUP_FILE when it wants to be woken.
# This script polls that file and sends the nudge when the time comes.
#
# Usage: nohup ./watcher.sh &

WAKEUP_FILE="${WAKEUP_FILE:-/tmp/cc-next-wakeup}"
NUDGE_SCRIPT="$(dirname "$0")/nudge.sh"
POLL_INTERVAL=60  # Check every 60 seconds

echo "[watcher] Started. Polling $WAKEUP_FILE every ${POLL_INTERVAL}s"

while true; do
    if [ -f "$WAKEUP_FILE" ]; then
        TARGET=$(cat "$WAKEUP_FILE" 2>/dev/null)
        NOW=$(date +%s)

        if [ -n "$TARGET" ] && [ "$NOW" -ge "$TARGET" ] 2>/dev/null; then
            echo "[watcher] Wakeup time reached (target: $TARGET, now: $NOW)"
            rm -f "$WAKEUP_FILE"
            bash "$NUDGE_SCRIPT"
        fi
    fi

    sleep "$POLL_INTERVAL"
done
