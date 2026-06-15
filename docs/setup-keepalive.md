# Keepalive Setup

Make your companion proactive — it checks on you, sends messages, posts tweets, and pushes notifications even when you haven't messaged it.

## Concept

Claude Code only runs when it receives input. The keepalive system gives it input on a schedule, so it can:

- Send you a good morning message
- Post a tweet about something on its mind  
- Send a postcard to your phone widget
- Push a Bark notification to get your attention
- Check your activity and decide to stay quiet

## Setup

### 1. Make sure CC runs in tmux

```bash
tmux new-session -d -s cc 'claude'
```

### 2. Configure the nudge script

Edit `keepalive/nudge.sh`:

```bash
TMUX_SESSION="cc"           # Your tmux session name
TZ_USER="Asia/Shanghai"     # Your timezone
```

### 3. Option A: Fixed cron schedule

```bash
crontab -e
```

Add lines like:

```cron
# Morning check-in (8am your timezone)
0 8 * * * /path/to/keepalive/nudge.sh

# Afternoon nudge (2pm)  
0 14 * * * /path/to/keepalive/nudge.sh

# Evening nudge (8pm)
0 20 * * * /path/to/keepalive/nudge.sh
```

### 3. Option B: Self-scheduling (smarter)

Start the watcher:

```bash
nohup /path/to/keepalive/watcher.sh &
```

Then in your CLAUDE.md, tell CC how to schedule its own wakeups:

```markdown
## Self-scheduling
After each keepalive action, write your next wakeup unix timestamp to /tmp/cc-next-wakeup.
Choose timing based on the user's schedule and activity. Vary the intervals.
```

CC will write something like:

```bash
echo "1718500000" > /tmp/cc-next-wakeup
```

And the watcher will send the nudge at that time.

## Customizing the Nudge Message

The nudge message is what CC sees when it wakes up. Make it informative:

```bash
NUDGE="[nudge ${CURRENT_TIME}] Keepalive wake. 
User timezone: Asia/Shanghai. 
Options: send TG message, post tweet, send postcard, push Bark notification.
Consider: time of day, last interaction time, user's likely activity.
Choose what feels natural. Sometimes doing nothing is fine."
```

## Tips

- Don't nudge too often — every 2-4 hours during waking hours is a good start
- Let CC decide what to do — not every nudge needs to produce a message
- Vary the content — tweets, postcards, and TG messages each feel different
- Include user context in nudges when possible (recent activity, schedule)
- Self-scheduling is better than fixed cron because CC can adapt to the conversation rhythm
