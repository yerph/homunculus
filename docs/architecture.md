# 系统架构总览

这篇文档帮你理解整个 companion-kit 是怎么运作的——每个服务是什么、做什么、怎么连在一起。就算你完全不懂后端也没关系，我们一步一步讲。

---

## 整体结构图

```
你（真人用户）
├── Telegram App ──────────▶ TG Bot API ──▶ CC Telegram 插件 ──┐
├── 浏览器（网页聊天）─────▶ chat-server ────────────────────┤
├── 手机小组件（浏览器）───▶ phone-widget ───────────────────┤
│                                                              │
│                           ┌──────────────────────────────┐   │
│                           │     Claude Code 会话          │◀──┘
│                           │    （在 tmux 里持续运行）      │
│                           │                              │
│                           │  上下文中包含：               │
│                           │  - CLAUDE.md（人设文件）       │
│                           │  - MCP 工具（TG、网页等）      │
│                           │  - 所有频道的消息              │
│                           │  - 工具调用历史                │
│                           └──────────┬───────────────────┘
│                                      │
│                                      ▼
└── Bark 推送通知 ◀──────── CC 通过 Bash 工具调用 curl
```

**核心思路**：Claude Code 是大脑，所有消息渠道最终都汇入它的上下文窗口。它读到消息后，决定怎么回复、用哪个渠道回复。

---

## 各个服务详解

### Claude Code（大脑）

这是整个系统的核心。Claude Code（简称 CC）是 Anthropic 官方的 CLI 工具，能在终端里与 Claude 模型交互。

- **运行方式**：在 `tmux` 会话里持续运行（什么是 tmux？简单说就是一个让程序在后台保持运行的工具，即使你关掉终端窗口它也不会断）
- **做什么**：接收所有渠道的消息，理解上下文，做出回复决策
- **怎么交互**：通过 MCP（Model Context Protocol）工具与外部服务通信
- **人设文件**：`CLAUDE.md` 定义了你的 companion 的性格、说话方式、记忆等

### Chat Server（网页聊天服务）

一个基于 Express.js 的网页服务器，提供功能完整的浏览器端聊天界面。

- **作用**：让你可以在浏览器里跟 companion 聊天，支持长对话管理
- **功能**：
  - 密码登录验证
  - 多对话管理 —— 侧边栏列表、文件夹整理、搜索与日历
  - CC 模式 + API 模式一键切换
  - API 模式支持 Anthropic / OpenAI / OpenRouter 等服务商，流式输出
  - 自定义表情包面板
  - 代码语法高亮（highlight.js）
  - Markdown 渲染
  - 消息编辑与重新生成、回复变体导航
  - 自定义头像上传
  - 深色 / 浅色主题切换
  - 对话导入 / 导出
- **与 CC 的连接方式**（CC 模式）：通过 `web-channel` MCP 插件，消息会自动出现在 CC 的上下文中
- **与 AI API 的连接方式**（API 模式）：在设置面板配置 API Key 和模型，消息直接发送到 AI 服务商
- **端口号**：可在 `.env` 中配置

### Phone Widget（手机小组件）

一个轻量级的 Node.js 服务器，提供手机端的 iMessage 风格聊天界面。

- **作用**：在手机上提供轻量聊天入口，模拟手机造型的 UI
- **功能**：
  - CC 模式 + API 模式一键切换（与 chat-server 相同的双模式架构）
  - API 模式支持 Anthropic / OpenAI / OpenRouter 等服务商，流式输出
  - 原生 Node.js HTTP + WebSocket 服务器（没有用 Express 框架）
  - 前端服务端口和内部 MCP 桥接端口分开（端口号可在 `.env` 中配置）
  - `bridge.js` 是一个 MCP stdio 服务器，CC 通过它来通信
- **数据存储**：聊天记录存在 JSONL 文件里

### Telegram（外部服务）

用 Telegram 跟 companion 聊天——最接近"正常聊天"的方式。

- **运作方式**：使用 Claude Code 内置的 Telegram 插件
- **消息流向**：你在 Telegram 发消息 → Telegram 服务器 → CC 的 Telegram 插件 → 出现在 CC 上下文中
- **回复方式**：CC 使用 `reply` MCP 工具回复
- **你需要做什么**：创建一个 Telegram Bot，安装插件，配置权限（详见 [Telegram 设置指南](setup-telegram.md)）
- 不需要你自己搭服务器，插件内置在 CC 里

### Nginx（反向代理）

Nginx 是一个高性能的 Web 服务器，在这个项目里它充当"门卫"的角色。

- **作用**：
  - 反向代理——把外部请求转发到正确的后端服务（端口号可在 `.env` 中配置）
  - SSL 证书管理——让你的网站支持 HTTPS（加密传输）
  - 路由分发——根据域名或路径把请求送到 chat-server 或 phone-widget
  - Cookie 验证——处理登录状态
- **为什么需要它**：浏览器直接访问后端服务不安全也不方便，Nginx 统一管理入口

### Keepalive（定时唤醒系统）

让 companion 主动找你聊天，而不是只在你发消息时才回复。

- **原理**：定时向 CC 的 tmux 会话发送一条"唤醒消息"，CC 醒来后自己判断该做什么
- **两种模式**：
  - **固定 cron 定时**：每隔几个小时唤醒一次
  - **自调度模式**：CC 自己决定下次什么时候醒来（更智能）
- **CC 醒来后可能做的事**：发 Telegram 消息、发推文、发明信片、发 Bark 推送，或者判断现在不该打扰你然后继续休眠
- 详见 [Keepalive 设置指南](setup-keepalive.md)

---

## 消息流向详解

### 收到消息（用户 → CC）

| 渠道 | 流程 |
|------|------|
| Telegram | 你发消息 → Telegram 服务器 → CC 的 Telegram 插件 → 出现在 CC 上下文中 |
| 网页聊天 | 你在浏览器打字 → chat-server API → web-channel MCP → 出现在 CC 上下文中 |
| 手机小组件 | 你在小组件打字 → phone-widget WebSocket → bridge.js MCP → 出现在 CC 上下文中 |

### 发出消息（CC → 用户）

| 类型 | CC 的操作 |
|------|-----------|
| Telegram 回复 | 调用 `mcp__plugin_telegram_telegram__reply` 工具 |
| 网页聊天回复 | 调用 `mcp__web-channel__reply` 工具 |
| 发推文 | 通过 Bash 工具调用 `POST /api/tweets` |
| 发明信片 | 通过 Bash 工具调用 `POST /api/mails` |
| 推送通知 | 通过 Bash 工具调用 Bark API（`curl` 命令） |

---

## 数据存储

| 数据类型 | 存储方式 | 位置 |
|----------|----------|------|
| 聊天记录 | JSON 文件 | `chat-server/data/conversations/` 目录下 |
| 推文 | JSONL 文件 | `phone-widget/tweets.jsonl` |
| 明信片 | JSONL 文件 | `phone-widget/mails.jsonl` |
| 表情包/贴纸 | JSON 文件 | `chat-server/stickers.json` |

**隐私说明**：所有数据都存储在你自己的 VPS 上，不会发送到第三方服务。唯一的例外是 Telegram 消息会经过 Telegram 的服务器，Bark 推送会经过 Apple 的推送服务——这是这两个服务本身的工作方式，无法避免。

---

## 常见问题

**Q：这些服务之间是怎么通信的？**
A：所有服务通过 MCP（Model Context Protocol）与 Claude Code 通信。MCP 是 Anthropic 设计的一种协议，让 AI 模型能安全地调用外部工具。你不需要深入理解 MCP 的技术细节，只需要知道"它是消息的桥梁"就行。

**Q：我必须全部搭建吗？**
A：不必。你可以只用 Telegram（最简单），或者只搭 chat-server（网页聊天），按需选择。phone-widget、Bark 推送、keepalive 都是可选的增强功能。

**Q：数据安全吗？**
A：所有数据在你的 VPS 上，你完全控制。建议配置好 Nginx 的 SSL 证书（HTTPS）并设置强密码。
