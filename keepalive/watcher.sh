#!/bin/bash
# 自调度 Watcher —— CC 自己决定下次什么时候醒来
#
# 工作原理：
#   CC 把下次唤醒的 unix 时间戳写到 WAKEUP_FILE
#   这个脚本每 60 秒检查一次，时间到了就执行 nudge.sh
#
# 用法：nohup ./watcher.sh &

WAKEUP_FILE="${WAKEUP_FILE:-/tmp/cc-next-wakeup}"
NUDGE_SCRIPT="$(dirname "$0")/nudge.sh"
POLL_INTERVAL=60  # 每 60 秒检查一次

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
