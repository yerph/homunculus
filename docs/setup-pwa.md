# PWA Setup

Turn your web frontend into an installable app on both mobile and desktop — with your own custom icon and name.

## What You Get

- **iOS**: "Add to Home Screen" puts your app icon on the home screen, opens in fullscreen
- **Android**: Install prompt, app icon in launcher, opens standalone
- **Desktop (Chrome/Edge)**: Install as desktop app with its own window and taskbar icon

## 1. Create Icons

You need at least two icon sizes:

- `icon-192.png` (192x192) — used on Android and desktop
- `icon-512.png` (512x512) — used for splash screens
- `apple-touch-icon.png` (180x180) — used on iOS

Place them in your `public/` directory.

**Tip**: Use a simple, high-contrast design. The icon should be recognizable at small sizes.

## 2. Create manifest.json

Already included in the phone-widget template at `public/manifest.json`:

```json
{
  "name": "Companion",
  "short_name": "Companion",
  "description": "Your AI companion",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a1a",
  "theme_color": "#1a1a1a",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**Customize**: Change `name`, `short_name`, `background_color`, and `theme_color` to match your theme.

## 3. Link in HTML

Add these to your HTML `<head>`:

```html
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## 4. Service Worker (Optional)

A service worker enables offline support and is required for the install prompt on some browsers:

```javascript
// sw.js
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
```

Register it in your HTML:

```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```

## 5. Install

### iOS
1. Open the URL in Safari
2. Tap the Share button
3. Tap "Add to Home Screen"
4. Name it and tap "Add"

### Android / Desktop Chrome
1. Open the URL
2. You should see an install prompt in the address bar
3. Click "Install"

## Desktop Icon Size

The default 192px icon may appear small on desktop. For better desktop appearance, add a 512px icon and reference it in your manifest. Some platforms will use the largest available icon.

## Tips

- iOS ignores `manifest.json` for some properties — use the `apple-` meta tags
- Test on actual devices, not just browser DevTools
- Clear browser cache if icons don't update
- Desktop PWAs get their own window — great for having your companion always visible
