# Bark Push Notification Setup

[Bark](https://github.com/Finb/Bark) is a free iOS app that lets you receive push notifications via a simple HTTP call. Perfect for getting pinged when your companion sends you something.

## 1. Install Bark

Download [Bark](https://apps.apple.com/app/bark/id1403753865) from the App Store.

## 2. Get Your Key

Open Bark and copy your push URL. It looks like:

```
https://api.day.app/YOUR_KEY/title/body
```

The `YOUR_KEY` part is what you need.

## 3. Configure

Add your Bark key(s) to `.env`:

```env
BARK_KEY_1=your-primary-device-key
BARK_KEY_2=your-secondary-device-key  # optional
BARK_ICON_URL=https://example.com/your-icon.png
BARK_GROUP=companion
```

## 4. Add to CLAUDE.md

Tell your companion how to send push notifications:

```markdown
## Push Notifications
To send a Bark push notification:
curl "https://api.day.app/BARK_KEY/Title/Message?icon=ICON_URL&group=GROUP"

Send to both devices when you want to make sure I see it.
Don't overuse — save for important messages or when I might miss a Telegram notification.
```

## 5. Test

```bash
curl "https://api.day.app/YOUR_KEY/Test/Hello from your companion?icon=https://example.com/icon.png&group=companion"
```

You should receive a push notification on your phone.

## Tips

- Bark is free with no rate limits, but don't spam
- Use it as a complement to Telegram, not a replacement
- Good for: keepalive nudges, important updates, surprise messages
- The `group` parameter groups notifications together in Notification Center
- Custom icons make notifications recognizable at a glance
