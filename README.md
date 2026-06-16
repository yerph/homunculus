# homunculus

> 感谢社区里所有开源项目和分享教程的前辈们。

一套多渠道 AI companion 系统 —— 支持 **Claude Code 模式**和 **API 模式**双模切换。

**CC 模式**：把 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 从命令行工具变成一个住在你所有设备上的 companion，能主动找你聊天。
**API 模式**：直接调用 Anthropic / OpenAI / OpenRouter 等 AI API，不依赖 Claude Code 也能用。

两种模式共享同一套前端，一键切换。

- **网页聊天** —— 完整的聊天界面，多对话管理、表情包、代码高亮，任何浏览器都能打开
- **Telegram 聊天** —— 随时随地，用手机回消息（CC 模式）
- **手机组件** —— iMessage 风格轻量界面，CC 与 API 双模式
- **主动找你说话** —— 推送通知、定时消息，不需要你先开口（CC 模式）
- **像真正的 App 一样安装** —— 支持 PWA，手机桌面和电脑桌面都能装

---

## 这个项目是什么，给谁用的

这是一套 AI companion 的多渠道前端系统，支持两种工作模式：

- **CC 模式**：Claude Code 默认只能在终端里用，这套工具给它加上网页聊天、Telegram、手机推送等渠道，让它变成一个可以主动找你、你也可以随时找到它的 companion。
- **API 模式**：不需要 Claude Code，直接调用 Anthropic、OpenAI、OpenRouter 等 AI API。适合没有 CC 订阅、或者想用其他模型的场景。

两种模式可以一键切换，共享同一套界面和对话记录。

**不需要你是程序员。** 这篇教程会尽量解释每一步在做什么、为什么要做。

---

## 架构总览

下面这张图展示了所有模块怎么连在一起。不用一次看懂，后面每个模块都会单独解释。

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Telegram    │────▶│                  │◀────│    浏览器        │
│  (机器人)    │     │   Claude Code    │     │  (chat-server)  │
└─────────────┘     │   (交互式会话)    │     └────────┬────────┘
                     │                  │              │
┌─────────────┐     │   MCP 插件：      │     ┌────────▼────────┐
│    Bark      │◀────│   - telegram     │     │  AI API (可选)   │
│  (推送通知)   │     │   - web-channel  │     │ Anthropic/OpenAI │
└─────────────┘     │   - tools        │     └─────────────────┘
                     │                  │
┌─────────────┐     │                  │     ┌─────────────────┐
│   定时唤醒    │────▶│                  │◀────│   手机组件       │
│ (keepalive)  │     └──────────────────┘     │ (phone-widget)  │
└─────────────┘                               └─────────────────┘
```

**核心思路：** 所有前端（chat-server、phone-widget）都支持 **CC 模式**和 **API 模式**双模切换。CC 模式下，消息通过 MCP 进入 Claude Code 的上下文窗口；API 模式下，消息直接发送到 AI API。Keepalive 系统会定时唤醒 CC，让它可以主动找你聊天。

---

## 模块说明

| 模块 | 说明 |
|------|------|
| **chat-server** | 功能完整的网页聊天前端 —— 多对话管理 + 文件夹整理、表情包面板、代码语法高亮、CC 与 API 双模式切换、Markdown 渲染、对话搜索与日历、消息编辑与重新生成、头像自定义、深色 / 浅色主题 |
| **phone-widget** | 手机造型的小组件，iMessage 风格聊天气泡，支持 CC 与 API 双模式，适合嵌入网页或作为移动端入口 |
| **nginx 配置** | 反向代理，把所有服务统一到一个域名下，处理 HTTPS |
| **keepalive** | 定时唤醒脚本，让 Claude Code 可以主动发消息 |
| **CLAUDE.md** | CC Profile —— 定义 Claude Code 的身份、性格和行为方式 |

---

## 前提条件

开始之前，请确认你有以下东西。如果某个词你完全没听过，下面有解释。

### 必需

| 你需要的 | 它是什么 / 为什么需要 |
|---------|---------------------|
| **一台 VPS** | VPS 是"虚拟专用服务器"（Virtual Private Server），简单理解就是你在云端租的一台电脑，24 小时开机，有独立的公网 IP。你的所有服务（聊天网页、Claude Code 等）都跑在这上面。推荐 Ubuntu 22.04 或更新的版本。常见的 VPS 提供商有 Vultr、DigitalOcean、Hetzner、搬瓦工等，最便宜的方案每月大约 $5-10。 |
| **Claude Code 订阅** | Claude Code 是 Anthropic 的命令行工具，需要 Pro 或 Max 订阅才能使用。Max 订阅额度更高，如果你打算频繁聊天建议选 Max。 |
| **Node.js 18+** | Node.js 是运行 JavaScript 的环境，chat-server 和 phone-widget 都需要它。大部分 VPS 不预装，需要自己安装。 |
| **nginx** | nginx（读作 "engine-x"）是一个反向代理服务器。它的作用是：你的浏览器访问 `https://你的域名.com`，nginx 把请求转发到后面正确的服务。没有它，你没法用域名 + HTTPS 访问你的服务。 |
| **一个域名** | 用来访问你的网页聊天和手机组件。也是 HTTPS 证书所必需的。可以从 Namecheap、Cloudflare 等地方买一个。 |
| **Telegram 机器人 Token** | 从 Telegram 的 [@BotFather](https://t.me/botfather) 创建机器人后获得。这是连接 Telegram 聊天的钥匙。 |

### 可选

| 你可能还想要的 | 说明 |
|-------------|------|
| **Bark App（iOS）** | 一个免费的 iOS 推送通知应用。装了它之后，Claude Code 可以往你的 iPhone 发推送。不用 iOS 的可以跳过。 |
| **SSL 证书** | HTTPS 需要证书。推荐用免费的 [Let's Encrypt](https://letsencrypt.org/)，配合 `certbot` 工具自动申请和续期。 |

---

## 安装教程（一步一步来）

### 第 1 步：准备 VPS 环境

SSH 登录你的 VPS 后，先确保基础工具都装好了。

```bash
# 更新系统包列表（让系统知道有哪些软件可以装）
sudo apt update

# 安装 nginx（反向代理）和 certbot（自动申请 SSL 证书）
sudo apt install -y nginx certbot python3-certbot-nginx

# 安装 Node.js 18+
# 如果你的系统默认 Node 版本太旧，可以用 nvm 管理：
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 18

# 安装 tmux（让 Claude Code 在后台持续运行）
sudo apt install -y tmux
```

**为什么需要 tmux？** Claude Code 是一个交互式命令行程序，关掉终端它就退出了。tmux 创建一个虚拟终端，即使你断开 SSH 连接，Claude Code 也能继续运行。

### 第 2 步：克隆项目

```bash
git clone https://github.com/yerph/homunculus.git
cd homunculus
```

**"克隆"是什么意思？** 就是从 GitHub 把项目代码下载到你的 VPS 上。

### 第 3 步：安装依赖

```bash
# 给 chat-server 安装依赖
cd chat-server && npm install && cd ..

# 给 phone-widget 安装依赖
cd phone-widget && npm install && cd ..
```

**为什么要 `npm install`？** 每个 Node.js 项目都会用到一些第三方库（比如 web 服务器框架）。`npm install` 会读取 `package.json` 文件，自动下载所有需要的库到本地。

### 第 4 步：配置环境变量

```bash
# 复制示例配置文件
cp .env.example .env
```

然后编辑 `.env` 文件（用 `nano .env` 或你喜欢的编辑器）：

```env
# 聊天服务的密码（访问网页聊天时需要输入，防止别人乱进来）
CHAT_PASSWORD=在这里设置一个密码

# 你的域名
DOMAIN=你的域名.com

# Bark 推送（如果你用 iOS，可选）
BARK_KEY_1=你的bark密钥
BARK_ICON_URL=https://你的域名.com/你的图标.png
BARK_GROUP=companion

# 名称和头像字母（显示在界面上的）
COMPANION_NAME=你的CC名字
COMPANION_AVATAR=C
```

各服务的端口号也在 `.env` 中配置。具体有哪些端口可以看 `.env.example` 里的注释。

**为什么用 .env 文件？** 密码、密钥这类敏感信息不应该直接写在代码里。`.env` 文件只存在于你的 VPS 上，不会被上传到 GitHub。

### 第 5 步：设置 CC Profile

```bash
cp CLAUDE.md.example CLAUDE.md
```

然后编辑 `CLAUDE.md`，这是整个项目最重要的文件之一。它定义了 Claude Code 的身份 —— 性格、说话方式、行为逻辑等等。

Claude Code 在每次启动时会读取这个文件，并按照里面的描述来行事。

`CLAUDE.md.example` 提供了一个基础模板，包括：
- **身份**：名字、性格特点、说话风格
- **行为准则**：主动聊天、有自己的观点、展现情绪
- **沟通风格**：不同渠道（Telegram / 网页）用不同的语气
- **主动消息逻辑**：被 keepalive 唤醒时怎么决定做什么

把模板改成你想要的样子就好。这是最需要花心思的部分，也是让每个人的 CC 都独一无二的关键。

### 第 6 步：配置 nginx 反向代理

```bash
# 先编辑配置文件里的域名和路径
nano nginx/companion.conf
# 把里面所有 YOUR_DOMAIN 替换成你的实际域名

# 复制到 nginx 配置目录
sudo cp nginx/companion.conf /etc/nginx/sites-enabled/

# 测试配置是否有语法错误
sudo nginx -t

# 没问题的话，重新加载 nginx
sudo systemctl reload nginx
```

**反向代理在做什么？** 你的 VPS 上跑着好几个服务（chat-server、phone-widget），各自监听不同的端口。nginx 统一接收来自外部的请求（通过你的域名），然后根据 URL 路径分发给对应的服务。比如访问 `/` 走 chat-server，访问 `/phone/` 走 phone-widget。

如果你还没有 SSL 证书，用 certbot 自动申请：

```bash
sudo certbot --nginx -d 你的域名.com
```

certbot 会自动修改 nginx 配置、申请 Let's Encrypt 免费证书、配置自动续期。

### 第 7 步：配置 Telegram

1. 在 Telegram 里找到 [@BotFather](https://t.me/botfather)，发送 `/newbot`，按提示创建一个机器人
2. 保存好机器人的 Token（长得像 `123456:ABC-DEF...`）
3. 安装 Claude Code 的 Telegram 插件：

```bash
claude /install-plugin telegram
```

4. 配置访问权限（让你的 Telegram 账号能和 Claude Code 通信）：

```bash
claude /telegram:access
```

详细步骤参见 [Telegram 配置指南](docs/setup-telegram.md)。

### 第 8 步：启动所有服务

```bash
# 启动 chat-server
cd chat-server && node server.js &

# 启动 phone-widget
cd phone-widget && node server.js &

# 用 tmux 启动 Claude Code（这样关掉终端它也不会退出）
tmux new-session -d -s cc 'claude'
```

**如何确认服务跑起来了？** 打开浏览器，访问 `https://你的域名.com`，应该能看到登录页面。输入你在 `.env 里设置的密码，进入聊天界面。

要重新连上 Claude Code 的 tmux 会话（比如看看它在做什么）：

```bash
tmux attach -t cc
```

按 `Ctrl+B` 然后按 `D` 可以退出 tmux 而不关闭会话。

### 第 9 步（可选）：配置 Keepalive 定时唤醒

Keepalive 让 Claude Code 有"主动性"—— 它不只是被动等你说话，而是会定时醒来，决定要不要主动找你。

最简单的方式是用 cron 定时任务：

```bash
crontab -e
```

添加类似这样的行：

```cron
# 每天早上 8 点、下午 2 点、晚上 8 点唤醒一次（根据你的时区调整）
0 8 * * * /你的路径/homunculus/keepalive/nudge.sh
0 14 * * * /你的路径/homunculus/keepalive/nudge.sh
0 20 * * * /你的路径/homunculus/keepalive/nudge.sh
```

也可以让 Claude Code 自己安排下次唤醒时间（更智能），详见 [Keepalive 配置指南](docs/setup-keepalive.md)。

### 第 10 步（可选）：配置 Bark 推送通知

如果你用 iPhone，可以装 [Bark](https://apps.apple.com/app/bark/id1403753865) 来接收推送通知。

1. 从 App Store 下载 Bark
2. 打开 Bark，复制你的推送 URL，里面的密钥部分填到 `.env` 的 `BARK_KEY_1` 里
3. 在 `CLAUDE.md` 里告诉 CC 怎么发推送（模板里有示例）

这样 Claude Code 就可以在 keepalive 唤醒时往你手机发通知了。

除了 Bark，你也可以用 **PWA Web Push**（iOS 16.4+ / Android / Desktop 都支持）来实现推送通知，不依赖第三方 App。详见 [推送通知配置指南](docs/setup-pwa.md)。

详细步骤参见 [Bark 配置指南](docs/setup-bark.md)。

### 第 11 步（可选）：安装为 PWA

PWA（Progressive Web App）让你的网页聊天界面可以像一个真正的 App 一样安装到设备上 —— 有自己的图标、独立窗口、全屏显示。

**手机（iOS）：**
1. 用 Safari 打开你的聊天网址
2. 点击底部分享按钮
3. 选择"添加到主屏幕"
4. 命名后点"添加"

**手机（Android）：**
1. 用 Chrome 打开你的聊天网址
2. 浏览器会弹出安装提示，点击"安装"

**电脑（Chrome / Edge）：**
1. 打开你的聊天网址
2. 地址栏右侧会出现安装图标，点击安装
3. 安装后会有独立窗口和任务栏图标

自定义 PWA 图标：把你喜欢的图片裁成正方形，分别保存为 192x192 和 512x512 像素，替换 `public/icon-192.png` 和 `public/icon-512.png` 即可。

详细步骤参见 [PWA 配置指南](docs/setup-pwa.md)。

---

## 自定义与个性化

### 主题配色

默认主题是简约深色风格。你可以通过修改各前端的 CSS 变量来自定义配色：

```css
:root {
  --bg: #1a1a1a;
  --text: #e0e0e0;
  --accent: #b49664;
  --muted: #666;
  /* ... */
}
```

### CC 模式 与 API 模式

chat-server 支持两种模式，可以在设置面板里一键切换：

- **CC 模式**（默认）：消息通过 MCP web-channel 插件发送给 Claude Code 会话，CC 用 CLAUDE.md 中的身份回复。适合日常陪伴。
- **API 模式**：消息直接发送到 AI API（Anthropic、OpenAI、OpenRouter 等），不经过 Claude Code。适合 CC 不在线时、或者你想用不同的模型聊天。

在设置面板的 Providers 里添加你的 API 密钥和模型，保存后就可以切换到 API 模式使用。

### CC Profile

编辑项目根目录下的 `CLAUDE.md`。这个文件决定了 CC 的一切 —— 怎么说话、什么性格、怎么主动找你。花时间打磨它，这是整个体验的灵魂。

### PWA 图标

把你喜欢的图片做成 192x192 和 512x512 两个尺寸，替换 `public/` 目录下的 `icon-192.png` 和 `icon-512.png`。安装为 PWA 后，这就是显示在桌面上的图标。

---

## 项目结构

```
homunculus/
├── chat-server/           # 网页聊天前端 + API（CC + API 双模式）
│   ├── server.js          # Express 服务 + 流式 API 代理 + CC 桥接
│   ├── public/
│   │   └── index.html     # 完整聊天 UI（侧边栏、表情包、设置面板等）
│   └── package.json
├── phone-widget/          # 手机组件前端 + API
│   ├── server.js
│   ├── public/
│   │   ├── index.html
│   │   └── manifest.json
│   └── package.json
├── nginx/                 # nginx 反向代理配置
│   └── companion.conf
├── keepalive/             # 定时唤醒脚本
│   ├── nudge.sh
│   └── README.md
├── docs/                  # 各模块的配置指南
│   ├── architecture.md
│   ├── setup-telegram.md
│   ├── setup-bark.md
│   ├── setup-keepalive.md
│   └── setup-pwa.md
├── CLAUDE.md.example      # CC Profile 模板
├── .env.example           # 环境变量模板
├── LICENSE
└── README.md
```

---

## 常见问题 / 疑难排查

### 基础问题

**问：跑起来大概要花多少钱？**

你需要 Claude Code 订阅（Pro 或 Max，Max 额度更高，重度使用推荐 Max）和一台 VPS（每月大约 $5-10）。Telegram 机器人和 Bark 都是免费的。

**问：不买 VPS 行不行？**

chat-server 和 phone-widget 需要跑在一台能被外部访问到的机器上。VPS 是最简单的方案。如果你有自己的家庭服务器，可以配合内网穿透（比如 Cloudflare Tunnel、frp）来实现，但配置更复杂。

**问：Telegram 聊天会额外消耗 token 吗？**

会。从 Telegram 发来的消息会进入 Claude Code 的上下文窗口，消耗你的订阅额度。系统提示（CLAUDE.md 的内容）在每次会话开始时加载一次；单条聊天消息本身很轻量。

**问：chat-server 的 API 模式需要额外付费吗？**

API 模式需要你有对应服务商的 API Key（比如 Anthropic API Key 或 OpenRouter Key），按调用量计费，独立于 Claude Code 订阅。CC 模式不需要额外 API Key，走的是你的 Claude Code 订阅额度。

### 疑难排查

**问：打开网址显示空白页或 502 Bad Gateway**

这通常意味着 nginx 在把请求转发给后端服务，但后端没在运行。检查：
1. chat-server 和 phone-widget 是否在运行？（`ps aux | grep node` 看一下）
2. `.env` 里配置的端口和 nginx 配置里写的端口是否一致？
3. 查看 nginx 错误日志：`sudo tail -f /var/log/nginx/error.log`

**问：Telegram 消息发了但 Claude Code 没回复**

1. 确认 Claude Code 的 tmux 会话还活着：`tmux ls`
2. 连上去看看：`tmux attach -t cc`，看 CC 是否卡住或已退出
3. 确认 Telegram 插件已正确安装和配置（`/telegram:access` 是否完成了配对）

**问：HTTPS / SSL 证书报错**

1. 确认你的域名 DNS 已经指向了你 VPS 的 IP 地址
2. 运行 `sudo certbot --nginx -d 你的域名.com` 重新申请证书
3. 证书过期了？certbot 通常会自动续期，检查：`sudo certbot renew --dry-run`

**问：PWA 安装后图标没更新**

浏览器会缓存 PWA 资源。清除浏览器缓存或在 manifest.json 的图标文件名后加查询参数（如 `icon-192.png?v=2`）来强制刷新。

**问：Keepalive 不工作 / Claude Code 没有主动发消息**

1. 确认 cron 任务已添加：`crontab -l`
2. 确认 nudge.sh 的路径正确、有执行权限：`chmod +x keepalive/nudge.sh`
3. 确认 tmux 会话名称和 nudge.sh 里配置的一致
4. 手动运行一次 nudge.sh 看有没有报错

**问：手机上网页聊天打字很卡 / 界面显示异常**

1. 确认你在用 Safari（iOS）或 Chrome（Android）访问
2. 清除浏览器缓存重试
3. 如果装了 PWA，先删掉重装

---

## 致谢

由 [yerph](https://github.com/yerph) 搭建，感谢整个社区的前辈们的启发。

## 许可证

MIT
