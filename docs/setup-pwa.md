# PWA 安装与推送通知设置指南（保姆级教程）

这篇教程教你把网页前端变成一个可安装的"App"——有自己的图标、名字、独立窗口，体验跟原生 App 几乎一样。同时还会详细讲解两种推送通知方案：Bark 推送和 PWA 原生推送。

---

## 什么是 PWA？

PWA（Progressive Web App，渐进式网页应用）是一种让网页"变成 App"的技术。安装后：

- 手机主屏幕上会出现你自定义的 App 图标
- 点开后全屏显示，没有浏览器的地址栏和工具栏
- 看起来和用起来就像一个真正的 App

**不需要上架应用商店，不需要审核，不需要写原生代码。**

---

## 安装后你会得到什么

| 平台 | 效果 |
|------|------|
| **iOS (iPhone/iPad)** | 主屏幕上出现你的 App 图标，点开后全屏显示，顶部状态栏颜色可自定义 |
| **Android** | 弹出安装提示，App 出现在桌面和应用列表里，完全独立的窗口 |
| **桌面 (Chrome/Edge)** | 安装为桌面应用，有自己的窗口和任务栏图标，可以固定在 Dock 栏 |

---

## 第一步：准备图标文件

你需要准备几个不同尺寸的图标：

| 文件名 | 尺寸 | 用途 |
|--------|------|------|
| `icon-192.png` | 192x192 像素 | Android 桌面图标、桌面端图标 |
| `icon-512.png` | 512x512 像素 | Android 启动画面（splash screen） |
| `apple-touch-icon.png` | 180x180 像素 | iOS 主屏幕图标 |

把这些图标文件放到你项目的 `public/` 目录下。

> **设计建议**：
> - 用简洁、高对比度的设计，因为图标在手机上显示时很小
> - 避免用文字，除非字体很大很粗
> - iOS 会自动给图标加圆角，不需要你自己做圆角
> - 如果不会做图标，可以用在线工具（搜索"PWA icon generator"）从一张大图自动生成各种尺寸

---

## 第二步：理解 manifest.json

`manifest.json` 是 PWA 的"身份证"，告诉浏览器你的"App"叫什么名字、长什么样。

phone-widget 模板里已经自带了一个 `public/manifest.json`：

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

**每个字段的含义**：

| 字段 | 说明 | 你应该改什么 |
|------|------|-------------|
| `name` | App 的完整名称，安装提示里会显示 | 改成你想要的名字 |
| `short_name` | 短名称，显示在主屏幕图标下面（通常 12 字符以内） | 改成简短的名字 |
| `description` | App 描述 | 可选修改 |
| `start_url` | 打开 App 时加载哪个页面 | 通常保持 `/` 不改 |
| `display` | 显示模式。`standalone` = 没有浏览器地址栏 | 不需要改 |
| `background_color` | 启动画面的背景色 | 改成你主题的背景色 |
| `theme_color` | 状态栏颜色（Android）和标题栏颜色（桌面） | 改成你主题的主色调 |
| `icons` | 图标列表 | 确保路径与你实际放的文件名一致 |

---

## 第三步：在 HTML 中引用

在你的 HTML 文件的 `<head>` 标签里添加以下内容：

```html
<!-- PWA 配置 -->
<link rel="manifest" href="/manifest.json">

<!-- iOS 专用配置 -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

**为什么 iOS 需要单独配置？**

因为 iOS Safari 对 `manifest.json` 的支持不完整。很多属性（比如图标、状态栏样式）iOS 不从 manifest.json 里读，而是从 HTML 的 `<meta>` 和 `<link>` 标签里读。所以必须两边都写。

**各行的作用**：
- `rel="manifest"` — 告诉浏览器去哪里找 manifest.json
- `apple-mobile-web-app-capable` — 告诉 iOS"这个网页可以全屏运行"
- `apple-mobile-web-app-status-bar-style` — 控制 iOS 顶部状态栏的样式。`black-translucent` 让状态栏半透明，内容可以延伸到状态栏下面
- `apple-touch-icon` — 告诉 iOS 用哪个图片作为主屏幕图标

---

## 第四步：配置 Service Worker

### Service Worker 是什么？

Service Worker 是浏览器在后台运行的一段 JavaScript 代码。你可以把它理解为你网页的"管家"——它能在你没打开网页的时候做事情。

**Service Worker 能做什么**：
- 拦截网络请求（实现离线缓存）
- 接收推送通知（即使网页没打开也能收到）
- 在后台同步数据

**在 PWA 中为什么必须有它**：
- 某些浏览器（尤其是 Chrome）要求网站有 Service Worker 才会显示"安装"提示
- 如果你想用 PWA 原生推送通知，Service Worker 是唯一的实现方式

### 创建 Service Worker 文件

在 `public/` 目录下创建 `sw.js`：

```javascript
// sw.js — Service Worker

// 安装事件：Service Worker 第一次安装时触发
self.addEventListener('install', (event) => {
  // skipWaiting() 让新的 Service Worker 立即激活，不用等旧的退出
  self.skipWaiting();
});

// 激活事件：Service Worker 激活时触发
self.addEventListener('activate', (event) => {
  // clients.claim() 让 Service Worker 立即控制所有页面
  event.waitUntil(clients.claim());
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
  // 这里直接转发请求，不做缓存
  // 如果你需要离线支持，可以在这里加缓存逻辑
  event.respondWith(fetch(event.request));
});

// 接收推送通知
self.addEventListener('push', (event) => {
  // 从推送消息中获取数据
  let data = { title: 'Companion', body: '你有新消息' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  // 显示通知
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // 点击通知时打开的页面
      data: { url: data.url || '/' }
    })
  );
});

// 用户点击通知时的处理
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // 打开对应页面
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});
```

### 注册 Service Worker

在你的主 HTML 文件里，添加以下 JavaScript（放在 `</body>` 之前或在你的入口 JS 文件里）：

```javascript
// 注册 Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then((registration) => {
      console.log('Service Worker 注册成功，范围：', registration.scope);
    })
    .catch((error) => {
      console.error('Service Worker 注册失败：', error);
    });
}
```

> **为什么要检查 `'serviceWorker' in navigator`？**
> 不是所有浏览器都支持 Service Worker。这个检查确保在不支持的浏览器上代码不会报错。

---

## 第五步：安装 PWA

### iOS (iPhone / iPad)

1. 用 **Safari** 打开你的网站（必须是 Safari，Chrome/Firefox 在 iOS 上不支持 PWA 安装）
2. 点底部工具栏的 **分享按钮**（那个正方形加向上箭头的图标）
3. 在弹出的菜单里向下滚动，找到 **"添加到主屏幕"**
4. 给 App 起个名字（会自动填入 manifest.json 里的 `short_name`）
5. 点右上角 **"添加"**
6. 回到主屏幕，你会看到新的 App 图标

> **iOS 注意事项和坑**：
> - iOS 上只有 Safari 可以安装 PWA，用 Chrome 打开是没有"添加到主屏幕"选项的
> - iOS 不会弹出自动安装提示，必须手动走分享菜单
> - iOS 的 PWA 不能后台运行 Service Worker（苹果的限制），所以 PWA 推送通知在 iOS 16.4 之前完全不可用
> - iOS 16.4 及以上版本开始支持 PWA 推送通知，但需要用户先安装 PWA 到主屏幕，并且在 App 内主动订阅通知
> - 如果图标不更新，尝试：删除主屏幕上的 PWA → 清除 Safari 缓存（设置 → Safari → 清除历史记录和网站数据）→ 重新添加

### Android

1. 用 **Chrome** 打开你的网站
2. 如果一切配置正确，地址栏会出现一个 **安装图标**（或者底部弹出安装横幅）
3. 点击 **"安装"**
4. App 会出现在桌面和应用抽屉里

> **Android 注意事项**：
> - Chrome 要求网站有 HTTPS、有 manifest.json、有 Service Worker 才会显示安装提示
> - 如果没看到安装提示，打开 Chrome 菜单（右上角三个点），看看有没有"安装应用"选项
> - Android 的 PWA 推送通知支持很好，跟原生 App 几乎一样

### 桌面 (Chrome / Edge)

1. 用 Chrome 或 Edge 打开你的网站
2. 地址栏右侧会出现一个 **安装图标**（像一个带加号的显示器）
3. 点击安装
4. App 会以独立窗口打开，任务栏上会有自己的图标

> **桌面注意事项**：
> - 默认的 192px 图标在桌面上可能显得小/模糊。在 manifest.json 里加上 512px 的图标，桌面端会自动使用更大的尺寸
> - 桌面 PWA 有自己独立的窗口，非常适合把 companion 聊天窗口常驻在屏幕上

---

## 第六步：推送通知方案对比

让 companion 能主动给你发通知是很重要的功能。有两种推送方案，各有优劣：

### 方案一：Bark 推送（仅 iOS）

Bark 是一个独立的 iOS App，通过简单的 HTTP 调用发送推送通知。

| 优点 | 缺点 |
|------|------|
| 设置极其简单，一行 curl 命令就能发 | 只支持 iOS |
| 不依赖浏览器，App 关了也能收到 | 需要额外安装一个 App |
| 没有频率限制 | 不能携带复杂数据 |
| 极其稳定可靠 | |

**适合**：你用 iPhone，想要最简单最可靠的推送方案。

详细设置方法见 [Bark 设置指南](setup-bark.md)。

### 方案二：PWA 原生推送（全平台）

PWA 自带的 Web Push 推送通知，走 W3C 标准协议。

| 优点 | 缺点 |
|------|------|
| 全平台支持（iOS 16.4+、Android、桌面） | 设置较复杂，需要配置 VAPID 密钥 |
| 不需要额外安装 App | iOS 上限制较多（必须先安装 PWA） |
| 浏览器标准，不依赖第三方 | 需要服务端代码配合 |
| 可以携带丰富数据和交互按钮 | iOS Safari 偶尔会"吞"通知 |

**适合**：你用 Android 或桌面端，或者想要一个统一的全平台方案。

### PWA 推送的实现步骤

如果你选择 PWA 推送方案，还需要以下额外步骤：

#### 1. 生成 VAPID 密钥

VAPID（Voluntary Application Server Identification）是 Web Push 的认证机制，确保只有你的服务器能给你的用户发推送。

```bash
# 安装 web-push 工具
npm install -g web-push

# 生成密钥对
web-push generate-vapid-keys
```

输出会是这样：

```
Public Key:  BNx...（一长串Base64字符）
Private Key: abc...（另一串Base64字符）
```

把这两个值保存到 `.env` 文件中：

```env
VAPID_PUBLIC_KEY=你的公钥
VAPID_PRIVATE_KEY=你的私钥
VAPID_EMAIL=mailto:your-email@example.com
```

#### 2. 前端订阅推送

在你的前端 JavaScript 中添加推送订阅逻辑：

```javascript
async function subscribePush() {
  // 确保 Service Worker 已注册
  const registration = await navigator.serviceWorker.ready;

  // 请求通知权限
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.log('用户拒绝了通知权限');
    return;
  }

  // 订阅推送
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,  // 必须为 true（浏览器要求）
    applicationServerKey: 'YOUR_VAPID_PUBLIC_KEY'  // 替换为你的公钥
  });

  // 把订阅信息发送到你的服务器保存
  await fetch('/api/push-subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription)
  });

  console.log('推送通知订阅成功');
}
```

#### 3. 服务端发送推送

在你的 Node.js 服务端：

```javascript
const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// subscription 是前端发过来的订阅对象
async function sendPush(subscription, title, body) {
  await webpush.sendNotification(
    subscription,
    JSON.stringify({ title, body })
  );
}
```

> **建议**：如果你只用 iPhone，直接用 Bark 就好，简单可靠。如果你需要跨平台，或者不想装额外的 App，再考虑 PWA 推送。两种方案也可以同时使用。

---

## 测试清单

安装好 PWA 之后，逐项检查：

- [ ] 打开网站时浏览器有没有显示安装提示（Android/桌面）
- [ ] 安装后主屏幕上有没有出现图标
- [ ] 图标是不是你设置的图片（不是默认的浏览器图标）
- [ ] 点开 App 是不是全屏显示（没有浏览器地址栏）
- [ ] `manifest.json` 里的 `name` 和 `short_name` 是否正确显示
- [ ] Service Worker 是否成功注册（打开浏览器开发者工具 → Application → Service Workers 查看）
- [ ] 推送通知权限是否已请求并允许
- [ ] 发送测试推送时是否能收到

**如何用浏览器开发者工具调试**：
1. Chrome 打开 `chrome://inspect` 或按 `F12`
2. 切到 **Application** 面板
3. 左侧选 **Manifest** — 检查你的 manifest.json 是否被正确解析
4. 左侧选 **Service Workers** — 检查 sw.js 是否注册成功、状态是否为 "activated"
5. 左侧选 **Push Messaging** — 可以手动发送测试推送

---

## 常见问题

**Q：iOS 上安装了 PWA 但收不到推送通知？**
- 确认你的 iOS 版本是 16.4 或更高（设置 → 通用 → 关于本机）
- PWA 必须先安装到主屏幕，然后在 App 内触发通知权限请求
- iOS Safari 的通知权限只能在用户操作（比如点击按钮）时请求，不能在页面加载时自动弹出
- 检查 设置 → 通知 里你的 PWA App 是否在列表中且已开启

**Q：Android 上看不到安装提示？**
- 确认网站是 HTTPS（HTTP 不行）
- 确认 manifest.json 配置正确（name、icons 必须有）
- 确认 Service Worker 已注册成功
- 尝试 Chrome 菜单（右上角三个点）→ "安装应用"

**Q：图标更新了但显示还是旧的？**
- 清除浏览器缓存
- iOS：删除主屏幕上的 PWA → 清除 Safari 缓存 → 重新添加
- Android：在系统设置的"应用管理"里找到你的 PWA，清除缓存
- 桌面：卸载 PWA 再重新安装

**Q：Service Worker 注册失败？**
- `sw.js` 必须放在网站根目录（`/sw.js`），不能放在子目录里（这是浏览器的安全限制，Service Worker 只能控制它所在目录及子目录的请求）
- 必须是 HTTPS（localhost 除外）
- 检查 sw.js 文件有没有语法错误（在浏览器开发者工具的 Console 面板看报错）

**Q：桌面端图标很小/模糊？**
- 在 manifest.json 的 `icons` 数组里加上 512px 的图标
- 浏览器会自动选择最合适的尺寸

**Q：PWA 推送和 Bark 推送可以同时用吗？**
- 完全可以。它们走不同的通道，互不影响。比如你可以 iPhone 上用 Bark（更稳定），桌面端用 PWA 推送

**Q：`standalone` 模式下状态栏不好看？**
- iOS：调整 `apple-mobile-web-app-status-bar-style`，可选值：`default`（白色）、`black`（黑色）、`black-translucent`（半透明，内容延伸到状态栏）
- Android：`theme_color` 决定了状态栏颜色
