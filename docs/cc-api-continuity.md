# CC / API 上下文互通 · 实现与部署说明

> **实现说明**：本模块基于经过实际运行验证的 CC Bridge 实现整理，保留消息同步、上下文补充、tmux 注入、JSONL 投递确认及失败重试机制。公开版本已移除私人配置、身份信息和无关服务依赖，并将必要的运行参数改为用户自行配置。
>
> **状态**：离线与本机伪造数据测试已通过；**没有拿真实账号、真实 CC Session 或真实聊天数据进行公开副本的端到端测试**。原版运行可靠不等于脱敏后的新部署无需联调。

## CC Hub 与 API 模式如何衔接

```text
               chat-server:4500 (现有前端)
                  /        \
             API mode       CC mode
              |                |
      API 返回成功后          POST /cc-msg
      保存 scoped 日志         |
       |                      | (本地 HTTP 代理，携独立 bridge token)
       +-- 原版 api-sync.js --> cc-bridge/hub.js:3462
                                  |
                           api-sync-inbox.js
                             + chat-log/recent
                                  |
                        forwardWithAPIContext()
                            (只补当前窗口，去重)
                                  |
                         原版 tmux 注入函数
                         injectCore() + 重试
                                  |
                       现有 Claude Code Session
                           /               \
                   CC JSONL tail         原版 MCP bridge
                     cc-tail.js           bridge.js
                           \               /
                            Hub 消息广播
                                 |
                     网页轮询、按会话落库
```

**同步时机与原版相同**：API 回合成功后保存并尝试推送同步收件箱，**不立刻唤醒 CC**。启用 `CC ↔ API context sync` 后，下一次在 Classic/CC 模式真正发送新消息时，Hub 才把该窗口的尚未交付 API 对话附在这条消息前面，等待 JSONL 入档确认；失败时仍保留投递状态用于恢复。CC → API 使用前端传来的 CC 消息/摘要，而不是读取 CC 隐藏推理。

## 对原有代码做过的脱敏与必要适配

保留了 `apiTurnKey()` 的 SHA-256 消息指纹、`apiDelivered` 和 `apiPending`、`fetchRecentAPI()` 对 inbox 与 API 聊天日志的合并、`forwardWithAPIContext()` 的按需补课、`injectCore()` 的 tmux 就绪等待/清残留/Enter、`_jsonlHas()` 和 `_scheduleVerify()` 的会话录入验证与补 Enter、`ccWaitQueue` 的断线暂存，以及原版 CC WebSocket/MCP 回复流和 JSONL tail。

仅为可公开部署而改变的接口：

- **Hub 配置**：不再内嵌生产令牌、私人页面 key、操作系统用户名或 tmux session 名。改用 `BRIDGE_AUTH_TOKEN`、`BRIDGE_TMUX`、`BRIDGE_TMUX_USER`、`BRIDGE_CC_SESSION_DIR` 和可选 `BRIDGE_DATA_DIR`。
- **用户身份**：消息 channel 标签的私有用户名换成通用 `chat-user`；提示中的专有称呼换成 User/Assistant。
- **私人功能剥离**：私人邮件、社交、小程序、主动推送、工作工单、终端高权限控制等不属于本次 CC/API 互通的路由和依赖不进入此公开副本。
- **对话来源**：Hub 使用配置的 `CHAT_PORT` 从 `chat-server` 的 `/api/chat-log/recent` 查询近期 API 回合；如果 API push 没送到，仍然能从聊天日志补读。
- **CC 回复**：Hub 沿用 `/api/stream/append` 回写，公开 `chat-server` 实现了此接口的最小版本，并按 `bridge_id` 去重。前端保存时也会保留该消息 ID；客户端覆盖历史前采用 CC 回复合并保护。
- **防护**：Hub 只绑定 `127.0.0.1`，浏览器通过已登录的 chat-server 代理调用；Hub 内部 API 使用独立 Token，公开反向代理不应映射 Hub 的私有端口。

注意：**这里刻意没有改写原版 API 消息选择、投递水位算法，也没有引入额外持久化租约队列。** 一次补课最多拼接原版选取的四个近期 API 回合；如有非常长的未同步跨度，需要结合真实场景检查原版交付状态的边界。

## 安装

要求 Node.js 20+、一个已登录的 Claude Code、tmux，并确保目标 tmux 会话由所配置的操作系统用户拥有。

```sh
# 在仓库根目录（不要复制任何原有生产 .env 或历史数据）
cp .env.example .env
# 在自己的 .env 中填写独立随机令牌、自己现有的 tmux 名和 CC JSONL 目录
npm --prefix chat-server ci
npm --prefix cc-bridge ci
```

`.env` 必须至少有：

```env
CHAT_PORT=4500
CHAT_PASSWORD=replace-with-your-own-random-chat-secret
BRIDGE_AUTH_TOKEN=replace-with-a-DIFFERENT-long-random-secret
BRIDGE_CLIENT_PORT=3462
BRIDGE_INTERNAL_PORT=3463
BRIDGE_TMUX=your-existing-tmux-session
BRIDGE_TMUX_USER=your-local-unix-user
BRIDGE_CC_SESSION_DIR=/absolute/path/to/your-own-cc-jsonl-project-directory
```

**两个服务进程分别启动**，例如从仓库根目录：

```sh
node --env-file=.env cc-bridge/hub.js
# 第二个终端
node --env-file=.env chat-server/server.js
```

最后在 **你自己的 Claude Code MCP 配置**里添加 stdio 服务：

```text
node /absolute/path/to/your-clone/cc-bridge/bridge.js
```

建议给这个子进程设置相同的 `BRIDGE_INTERNAL_PORT`。原版 `bridge.js` 中的 `web-channel` MCP 工具会连接 `127.0.0.1:3463`，并提供原版 `reply` / `edit_message` 能力。**不要把私人订阅登录态、API Key 或目录树打包进公开仓库**。

## 验证顺序

1. 先在独立测试 CC Session 上确认 Hub `/health`、前端 CC 状态与原版 MCP WebSocket 能连接。仅模拟测试不能证明 tmux 操作在你的 CC 版本中完全兼容。
2. 在 API 模式启用 CC Sync，聊一轮，再切 CC 发送新消息；确认 CC transcript 中出现本次 `[当前窗口新增API/-p对话...]` 前情，且没有重复注入已交付的回合。
3. 使用 `web-channel` 的 `reply` 返回消息，确认网页只出现一次；切回 API，确认 CC 回合出现在启用开关后的 API 上下文。
4. 复测切换新 conversation、关闭 CC Sync、断开 Hub、CC 重启、新 session、更长的 API 对话跨度。

本仓库自动测试只使用伪造消息和本地端口，不会连真实模型或 VPS 运行中的 CC。

## 数据边界与安全

`chat-server/data/`、`cc-bridge/data/` 和真实 CC JSONL 都是运行时私有数据，已排除在 Git 跟踪之外，备份时要严格保护。不能把裸 Hub 端口公开到互联网；不要为了方便给它加开放式 Nginx 转发。`cc-bridge` 使用的 stdio MCP 是一个需要你自己授权的工具执行环境。

原版 Hub 的某些运行策略是针对单用户、单 CC 长驻 Session 设计的；此开源副本**不承诺多租户隔离**，也不保证同一聊天被多个独立 CC Session 同时消费时自动正确。若要扩展为多用户平台，应重新设计身份映射和会话级消费确认，而不能照搬个人部署的权限假设。
