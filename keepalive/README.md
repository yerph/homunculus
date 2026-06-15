# Keepalive System

The keepalive system periodically wakes Claude Code so it can proactively send messages, tweets, postcards, or push notifications — even when you haven't messaged it.

## How It Works

1. A cron job or external trigger sends a "nudge" message to Claude Code's tmux session
2. Claude Code wakes up, reads the nudge, and decides what to do
3. It might send a Telegram message, post a tweet, send a postcard, or push a Bark notification
4. It sets the next wakeup time and goes back to sleep

## Setup

### Option 1: Cron-based (simplest)

Add to your crontab (`crontab -e`):

```cron
# Wake CC every 2 hours during daytime (adjust timezone and hours)
0 8-22/2 * * * /path/to/cc-companion-kit/keepalive/nudge.sh
```

### Option 2: Self-scheduling

Claude Code can write its own next wakeup timestamp to a file. A watcher script checks the file and sends the nudge at the right time.

```bash
# Run the watcher in the background
nohup /path/to/cc-companion-kit/keepalive/watcher.sh &
```

## Nudge Message Format

The nudge script sends a message like this to Claude Code's tmux session:

```
[nudge HH:MM] Keepalive wake. Check on the user, send something if appropriate.
```

You can customize the nudge message in `nudge.sh` to include context like:
- Current time in the user's timezone
- Recent activity data
- Suggestions for what to do (send TG, post tweet, send postcard, etc.)

## Bark Push Notifications

[Bark](https://github.com/Finb/Bark) is a free iOS app for receiving push notifications.

To send a Bark notification from Claude Code:

```bash
curl "https://api.day.app/YOUR_BARK_KEY/Title/Message?icon=YOUR_ICON_URL&group=companion"
```

Claude Code can call this via the Bash tool whenever it wants to ping your phone.

## Tips

- Vary the timing — don't always nudge at the same time
- Include context in the nudge message so CC makes better decisions
- Let CC decide what to do — sometimes doing nothing is the right call
- Consider the user's timezone and likely activity when scheduling
