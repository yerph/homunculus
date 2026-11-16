# API 模式：通用配置与验证

API 模式支持 Anthropic Messages API，以及 OpenAI Chat Completions 兼容端点（包括 DeepSeek 等兼容服务）。不需要 Claude Code 订阅即可独立使用。

## 配置

在网页设置中添加 Provider，填写**你自己的** API endpoint、模型 ID 和 API Key。示例文件不包含任何可用凭据，运行时配置会存储在 `chat-server/data/`（Git 已忽略）。

- OpenAI 兼容接口：例如 `https://api.deepseek.com/v1/chat/completions`，`api_format: "openai"`。
- Anthropic 原生接口：`https://api.anthropic.com/v1/messages`，`api_format: "anthropic"`。
- 对没有显式 `api_format` 的旧配置，服务端使用路径末尾 `/messages` 判断 Anthropic 格式；否则使用 OpenAI 兼容格式。
- Thinking 默认不开启。只有用户开启 Thinking、且 Provider 明确设置 `reasoning_format` 时，OpenAI 兼容请求才会携带额外推理参数。可选值：`openrouter` 或 `anthropic-compat`，**不保证每个兼容网关都接受**，请按服务商文档设置。Anthropic 原生接口仍按 Thinking 开关发送其原生参数。
- 可为某个 Provider 设置 `compression: true`，优先指定它为上下文压缩模型。未指定时会优先查找名称包含 `DeepSeek` 的 Provider，再选任意已配置的 OpenAI 兼容 Provider。压缩是可选功能，不会内置或代用任何人的 API Key。

## 稳定性

聊天请求在客户端连接中断时会取消上游流，默认 120 秒超时。可通过环境变量 `API_REQUEST_TIMEOUT_MS` 自定义毫秒数。上下文压缩独立采用 60 秒超时。上游错误仅返回状态码，不向前端透传可能包含凭据的原始错误正文。

## 自测（不会调用真实 API）

```bash
npm --prefix cc-bridge ci
npm --prefix chat-server ci
npm --prefix chat-server test
```

测试使用本机模拟提供商和独立模拟 Hub，不连接真实 CC，覆盖 OpenAI 与 Anthropic 流式聊天、DeepSeek 优先压缩、Anthropic 原生压缩、错误脱敏以及 Provider 重排后的密钥关联。不需要填写真实凭据。

## 安全提示

不要将 `.env`、`chat-server/data/`、聊天记录、系统提示词、真实域名或服务器日志提交到公开仓库。部署时应在可信的访问控制之后暴露 API 服务；这些示例设置不代替安全审计。
