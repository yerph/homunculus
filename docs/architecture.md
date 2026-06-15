# Architecture Overview

## How It All Connects

```
You (Human)
├── Telegram App ──────────▶ TG Bot API ──▶ CC Telegram Plugin ──┐
├── Web Browser ───────────▶ chat-server (port 3500) ────────────┤
├── Phone Widget (browser) ▶ phone-widget (port 3462) ───────────┤
│                                                                 │
│                              ┌──────────────────────────────┐   │
│                              │     Claude Code Session      │◀──┘
│                              │     (tmux, interactive)      │
│                              │                              │
│                              │  Context contains:           │
│                              │  - CLAUDE.md (persona)       │
│                              │  - MCP tools (TG, web, etc.) │
│                              │  - All channel messages      │
│                              │  - Tool call history         │
│                              └──────────┬───────────────────┘
│                                         │
│                                         ▼
├── Bark Push Notification ◀── CC calls curl via Bash tool
├── Phone Widget tweets    ◀── CC calls POST /api/tweets
└── Phone Widget postcards ◀── CC calls POST /api/mails
```

## Services

### Claude Code (the brain)
- Runs in a tmux session for persistence
- All other services feed into its context
- Makes decisions about what to do and when
- Uses MCP tools to interact with external services

### Chat Server (port 3500)
- Express.js web server
- Serves the main chat frontend
- Handles password-based authentication
- Stores chat history in SQLite
- Custom sticker panel for sending images
- Connects to CC via the `web-channel` MCP plugin

### Phone Widget (port 3462 + 3463)
- Raw Node.js HTTP + WebSocket server
- Port 3462: serves frontend + API for tweets/mails/chat
- Port 3463: internal MCP bridge connection
- `bridge.js` is an MCP stdio server that CC communicates through
- Stores tweets and mails in JSONL files

### Telegram (external)
- Claude Code's built-in Telegram plugin
- Messages arrive as `<channel>` events in CC's context
- CC replies via the `reply` MCP tool
- No server needed on your end — it's built into CC

### Nginx (port 80/443)
- Reverse proxy for all services
- Handles SSL termination
- Routes requests to the right backend
- Cookie-based authentication

### Keepalive (cron/watcher)
- Sends periodic nudge messages to CC's tmux session
- CC wakes up, checks the time, decides what to do
- Can self-schedule by writing next wakeup timestamp to a file

## Message Flow

### Incoming (user → CC)

1. **Telegram**: User sends message → Telegram servers → CC's TG plugin → appears in context
2. **Web chat**: User types message → chat-server API → web-channel MCP → appears in context
3. **Phone chat**: User types message → phone-widget WebSocket → bridge.js MCP → appears in context

### Outgoing (CC → user)

1. **Telegram reply**: CC calls `mcp__plugin_telegram_telegram__reply` tool
2. **Web chat reply**: CC calls `mcp__web-channel__reply` tool
3. **Tweet**: CC calls `POST /api/tweets` via Bash tool
4. **Postcard**: CC calls `POST /api/mails` via Bash tool
5. **Push notification**: CC calls Bark API via `curl` in Bash tool

## Data Storage

- **Chat history**: SQLite database in chat-server/
- **Tweets**: `tweets.jsonl` in phone-widget/
- **Postcards**: `mails.jsonl` in phone-widget/
- **Stickers**: `stickers.json` in chat-server/

All data is local to your VPS. Nothing is sent to third-party services (except Telegram messages through Telegram's servers, and Bark notifications through Apple's push service).
