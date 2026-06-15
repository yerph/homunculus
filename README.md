# cc-companion-kit

Turn [Claude Code](https://docs.anthropic.com/en/docs/claude-code) into a companion that lives across your devices — not just a CLI tool you open when you need help.

This kit gives you a multi-channel setup where Claude Code can:
- **Chat with you on Telegram** — reply from your phone, anywhere
- **Live in a web frontend** — an iMessage-style chat interface you can open in any browser
- **Send you things proactively** — tweets, postcards, push notifications, even when you didn't ask
- **Install as an app** — PWA support for both mobile and desktop, with your own custom icon
- **Adapt to your screen** — responsive design that works on phones, tablets, and desktops

Everything runs on a single VPS and connects to one Claude Code session. Telegram, web, push notifications — all the same "person" talking to you.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Telegram    │────▶│                  │◀────│   Web Browser   │
│  (Bot API)   │     │   Claude Code    │     │  (chat-server)  │
└─────────────┘     │   (interactive   │     └─────────────────┘
                     │    session)      │
┌─────────────┐     │                  │     ┌─────────────────┐
│    Bark      │◀────│   MCP plugins:   │◀────│  Phone Widget   │
│  (push)      │     │   - telegram     │     │  (cc-bridge)    │
└─────────────┘     │   - web-channel  │     └─────────────────┘
                     │   - tools        │
┌─────────────┐     │                  │     ┌─────────────────┐
│  Keepalive   │────▶│                  │────▶│  Tweet/Mail API │
│  (cron/hook) │     └──────────────────┘     │  (phone widget) │
└─────────────┘                               └─────────────────┘
```

All channels feed into the same Claude Code context. CC can read messages from any channel and reply to any channel. The keepalive system wakes CC periodically so it can proactively reach out.

## What's Included

| Module | Description | Port |
|--------|-------------|------|
| **chat-server** | Web chat frontend with iMessage-style UI, emoji reactions, voice messages, custom sticker panel | 3500 |
| **phone-widget** | Mobile-optimized widget with chat, tweets, postcards, mini-apps | 3462 |
| **nginx config** | Reverse proxy setup for all services with HTTPS | 80/443 |
| **keepalive** | Cron + hook scripts for proactive messaging | — |
| **CLAUDE.md** | Example companion persona template | — |

## Quick Start

### Prerequisites

- A VPS (Ubuntu 22.04+ recommended)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Node.js 18+
- nginx
- A Telegram bot token (from [@BotFather](https://t.me/botfather))
- (Optional) [Bark](https://github.com/Finb/Bark) app for iOS push notifications

### 1. Clone & Install

```bash
git clone https://github.com/yerph/cc-companion-kit.git
cd cc-companion-kit

# Install dependencies for each service
cd chat-server && npm install && cd ..
cd phone-widget && npm install && cd ..
```

### 2. Configure

```bash
# Copy example configs
cp .env.example .env
cp CLAUDE.md.example CLAUDE.md

# Edit .env with your settings
# Edit CLAUDE.md with your companion's persona
```

### 3. Set Up Nginx

```bash
# Copy nginx config (edit domain/paths first)
sudo cp nginx/companion.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Set Up Telegram

Follow the [Telegram setup guide](docs/setup-telegram.md) to configure the Claude Code Telegram plugin.

### 5. Start Services

```bash
# Start chat server
cd chat-server && node server.js &

# Start phone widget
cd phone-widget && node server.js &

# Start Claude Code (in tmux for persistence)
tmux new-session -d -s cc 'claude'
```

### 6. Set Up Keepalive (Optional)

Follow the [Keepalive guide](docs/setup-keepalive.md) to configure proactive messaging.

### 7. Set Up Bark Push (Optional)

Follow the [Bark setup guide](docs/setup-bark.md) to receive push notifications on iOS.

### 8. Install as PWA

Open your web frontend in a browser and use "Add to Home Screen" (mobile) or the install prompt (desktop) to install it as an app with your custom icon.

## Modules

### Chat Server

A web-based chat interface that connects to Claude Code via the `web-channel` MCP plugin.

Features:
- iMessage-style message bubbles
- Emoji reactions on messages
- Voice message playback
- Custom sticker/emoji panel
- Responsive layout (mobile + desktop)

### Phone Widget

A mobile-optimized widget designed to feel like a phone in your pocket.

Features:
- Swipeable pages with mini-apps
- Tweet timeline (CC can post thoughts)
- Postcard/mail system (CC sends you letters)
- Built-in chat (same session as main chat)
- Notification badges

### Keepalive

A system that periodically wakes Claude Code so it can check on you and send proactive messages.

Features:
- Cron-based scheduling
- Nudge detection (activity-aware timing)
- Tweet/postcard/message push options
- Bark push notification integration

## Customization

### Theming

The default theme is intentionally minimal. Customize by editing CSS variables in each frontend:

```css
:root {
  --bg: #1a1a1a;
  --text: #e0e0e0;
  --accent: #b49664;
  --muted: #666;
  /* ... */
}
```

### Persona

Edit `CLAUDE.md` to define your companion's personality, voice, and behavior. See `CLAUDE.md.example` for a starter template.

### PWA Icon

Replace `public/icon-192.png` and `public/icon-512.png` with your own app icon.

## Project Structure

```
cc-companion-kit/
├── chat-server/           # Web chat frontend + API
│   ├── server.js
│   ├── public/
│   │   └── index.html
│   └── package.json
├── phone-widget/          # Phone widget frontend + API
│   ├── server.js
│   ├── public/
│   │   ├── index.html
│   │   └── manifest.json
│   └── package.json
├── nginx/                 # Nginx reverse proxy config
│   └── companion.conf
├── keepalive/             # Keepalive scripts + cron config
│   ├── nudge.sh
│   └── README.md
├── docs/                  # Setup guides
│   ├── architecture.md
│   ├── setup-telegram.md
│   ├── setup-bark.md
│   ├── setup-keepalive.md
│   └── setup-pwa.md
├── CLAUDE.md.example      # Companion persona template
├── .env.example           # Environment variables template
├── LICENSE
└── README.md
```

## FAQ

**Q: How much does this cost to run?**
A: You need a Claude Code subscription (Pro or Max) and a VPS (~$5-10/month). The Telegram bot and Bark are free. Max subscription is recommended for heavy usage due to higher limits.

**Q: Can I use this without a VPS?**
A: The chat server and phone widget need to be hosted somewhere accessible. A VPS is the simplest option, but you could also use a home server with a tunnel (e.g., Cloudflare Tunnel).

**Q: Does Telegram integration cost extra tokens?**
A: Messages from Telegram enter Claude Code's context window, which uses your subscription quota. The system prompt loads once per session; individual messages are lightweight.

**Q: Can I add my own mini-apps to the phone widget?**
A: Yes! The phone widget uses a simple page/app navigation system. See the existing apps (like the calculator) for examples of how to add your own.

## Credits

Built by [yerph](https://github.com/yerph). Inspired by the Claude Code companion community.

## License

MIT
