#!/bin/bash
# 唤醒脚本 —— 向 Claude Code 的 tmux 会话发送一条唤醒消息
#
# 用法：
#   直接运行：bash nudge.sh
#   或者放到 crontab 里定时执行
#
# CUSTOMIZE: 修改下面的时区和 tmux 会话名

TMUX_SESSION="cc"           # CUSTOMIZE: 你的 tmux 会话名
TZ_USER="Asia/Shanghai"     # CUSTOMIZE: 你的时区

# 获取用户时区的当前时间
CURRENT_TIME=$(TZ="$TZ_USER" date '+%H:%M')

# 构建唤醒消息
# CUSTOMIZE: 修改这条消息，加入你希望 CC 醒来时看到的上下文
NUDGE="[nudge ${CURRENT_TIME}] Keepalive wake. Check on the user — send a message, tweet, or postcard if appropriate. Consider the time of day and what they might be doing."

# 通过 tmux paste-buffer 发送到 CC 的会话
tmux set-buffer -t "$TMUX_SESSION" "$NUDGE" 2>/dev/null && \
tmux paste-buffer -t "$TMUX_SESSION" 2>/dev/null && \
tmux send-keys -t "$TMUX_SESSION" Enter 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Nudge sent: $NUDGE"
