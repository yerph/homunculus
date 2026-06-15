# Telegram Setup

Connect Claude Code to Telegram so you can chat with your companion from your phone.

## 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts
3. Save the bot token (looks like `123456:ABC-DEF...`)

## 2. Install the Telegram Plugin

Claude Code supports Telegram via the official plugin system. Install it:

```bash
claude /install-plugin telegram
```

Or add it manually to your Claude Code settings:

```json
{
  "plugins": {
    "telegram": {
      "bot_token": "YOUR_BOT_TOKEN"
    }
  }
}
```

## 3. Configure Access

The Telegram plugin has an access control system. To allow your Telegram account to chat with CC:

```bash
claude /telegram:access
```

Follow the prompts to pair your Telegram user ID.

## 4. Start Chatting

Message your bot on Telegram. The message will appear in Claude Code's context as:

```
<channel source="plugin:telegram:telegram" chat_id="..." message_id="..." user="..." ts="...">
Your message here
</channel>
```

Claude Code can reply using the `reply` tool:

```
mcp__plugin_telegram_telegram__reply(chat_id, text)
```

## Tips

- Messages from Telegram enter CC's context window, consuming tokens
- CC can send images by passing file paths to the `files` parameter
- Use `react` to add emoji reactions to messages
- Use `edit_message` for updating progress (doesn't trigger push notification)
- For final results, always send a new `reply` so the user gets notified

## Adding to CLAUDE.md

Add instructions in your CLAUDE.md so your companion knows how to handle Telegram:

```markdown
## Telegram
When you receive messages from Telegram, reply naturally using the reply tool.
Keep messages short and conversational — like texting.
You can send multiple short messages instead of one long one.
```
