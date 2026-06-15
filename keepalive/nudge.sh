#!/bin/bash
# Nudge script — sends a keepalive message to Claude Code's tmux session
#
# CUSTOMIZE: Change the timezone, tmux session name, and nudge message format

TMUX_SESSION="cc"  # CUSTOMIZE: your tmux session name
TZ_USER="Asia/Shanghai"  # CUSTOMIZE: your timezone

# Get current time in user's timezone
CURRENT_TIME=$(TZ="$TZ_USER" date '+%H:%M')

# Build the nudge message
# CUSTOMIZE: Add any context you want CC to see when it wakes up
NUDGE="[nudge ${CURRENT_TIME}] Keepalive wake. Check on the user — send a message, tweet, or postcard if appropriate. Consider the time of day and what they might be doing."

# Send to tmux session via paste-buffer
tmux set-buffer -t "$TMUX_SESSION" "$NUDGE" 2>/dev/null && \
tmux paste-buffer -t "$TMUX_SESSION" 2>/dev/null && \
tmux send-keys -t "$TMUX_SESSION" Enter 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Nudge sent: $NUDGE"
