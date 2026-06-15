# Telegram 设置指南（保姆级教程）

这篇教程教你把 Claude Code 连接到 Telegram，这样你就能在手机上像正常聊天一样跟你的 companion 对话。

---

## 前置条件

- 你已经有一个 Telegram 账号
- 你的 VPS 上已经安装并能运行 Claude Code（`claude` 命令可以正常使用）

---

## 第一步：创建 Telegram Bot

Telegram 的 Bot（机器人）是你 companion 的"化身"。所有消息都通过这个 Bot 来收发。

1. 打开 Telegram，搜索 **@BotFather**（这是 Telegram 官方的机器人管理工具）
2. 给 BotFather 发送 `/newbot`
3. BotFather 会问你几个问题：
   - **Bot 的名字**：给你的 companion 起个名字，比如 `My Companion`（这是显示名，随时可以改）
   - **Bot 的用户名**：必须以 `bot` 结尾，比如 `my_companion_bot`（这个是唯一标识，设置后不能改）
4. 创建成功后，BotFather 会给你一个 **Bot Token**，看起来像这样：
   ```
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```
5. **保存好这个 Token！** 它就是你 Bot 的"密码"，有了它就能控制你的 Bot。不要分享给别人。

> **为什么需要 Bot？**
> Telegram 不允许普通用户账号被程序直接控制（会被封号）。Bot 是 Telegram 官方提供的、专门给程序使用的账号类型。

---

## 第二步：安装 Telegram 插件

Claude Code 通过插件系统支持 Telegram。在终端里运行：

```bash
claude /install-plugin telegram
```

这条命令会自动下载并安装 Telegram 插件。

**如果上面的命令不起作用**，你也可以手动配置。编辑 Claude Code 的设置文件（一般在 `~/.claude/` 目录下），添加：

```json
{
  "plugins": {
    "telegram": {
      "bot_token": "你的Bot Token粘贴在这里"
    }
  }
}
```

> **常见错误**：
> - Token 复制错了（多了空格或少了字符）——仔细检查
> - JSON 格式错误（漏了引号或逗号）——用 JSON 校验工具检查一下

---

## 第三步：配置访问权限

安装好插件后，需要把你的 Telegram 账号跟 Bot 绑定，这样 CC 才知道哪些人的消息需要回复。

在终端里运行：

```bash
claude /telegram:access
```

按照提示操作，完成你的 Telegram 用户 ID 绑定。

> **为什么需要这一步？**
> 你的 Bot 是公开的，任何人都能给它发消息。访问控制确保只有你的消息会被处理，其他人发过来的消息会被忽略。这是一个安全措施。

> **怎么找到我的 Telegram 用户 ID？**
> 在 Telegram 里搜索 `@userinfobot`，给它发任意消息，它会回复你的用户 ID（一串数字）。

---

## 第四步：开始聊天

一切配置好之后：

1. 在 Telegram 里找到你刚创建的 Bot
2. 给它发一条消息
3. 消息会出现在 Claude Code 的上下文中，格式类似：
   ```
   <channel source="plugin:telegram:telegram" chat_id="..." message_id="..." user="..." ts="...">
   你的消息内容
   </channel>
   ```
4. Claude Code 会用 `reply` 工具回复你，消息出现在 Telegram 聊天窗口里

---

## 第五步：在 CLAUDE.md 中添加指引

在你的 `CLAUDE.md` 文件里告诉 companion 怎么处理 Telegram 消息。比如：

```markdown
## Telegram
当你收到 Telegram 消息时，用 reply 工具自然地回复。
保持消息简短口语化——像发微信一样。
可以分几条短消息发，不用把所有内容塞进一条长消息里。
```

这一步不是技术配置，而是"教"你的 companion 在 Telegram 上怎么说话。CLAUDE.md 就是它的行为指南。

---

## 实用技巧

- **消息会消耗 Token**：每条 Telegram 消息都会进入 CC 的上下文窗口。如果聊得很多，上下文会变满，CC 会自动压缩早期内容
- **发图片**：CC 可以通过 `reply` 工具的 `files` 参数发送图片，传入文件的绝对路径即可
- **表情回应**：CC 可以用 `react` 工具给消息添加 emoji 表情回应
- **编辑消息**：CC 可以用 `edit_message` 工具修改已发送的消息（不会触发推送通知，适合更新进度）
- **最终回复用新消息**：如果需要用户看到推送通知，一定要发新的 `reply`，而不是编辑旧消息

---

## 常见问题

**Q：发了消息但 Bot 不回复？**
- 检查 Claude Code 是否在运行（tmux 会话是否还在）
- 检查 Bot Token 是否正确
- 检查访问权限是否配置好了（第三步）
- 在 CC 的终端里看看有没有报错信息

**Q：Bot 回复很慢？**
- 正常现象。CC 需要处理上下文、调用模型、生成回复，通常需要几秒到十几秒
- 如果超过一分钟没回复，检查 CC 是否卡住了

**Q：可以在群组里用吗？**
- 技术上可以，但不建议。companion 是为一对一对话设计的，群组里的消息量会快速填满上下文窗口

**Q：换了 VPS 怎么迁移？**
- 在新 VPS 上重新安装 Claude Code 和 Telegram 插件
- 把旧的 Bot Token 复制过去（不需要创建新 Bot）
- 重新配置访问权限
