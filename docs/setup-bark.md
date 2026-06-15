# Bark 推送通知设置指南（保姆级教程）

[Bark](https://github.com/Finb/Bark) 是一个免费的 iOS 推送通知工具。你只需要调用一个网址，就能在 iPhone 上收到推送通知。非常适合让 companion 在重要时刻"戳"你一下。

---

## 前置条件

- 一台 iPhone（Bark 目前只支持 iOS）
- 你的 VPS 上已经配置好 Claude Code

> **没有 iPhone 怎么办？**
> 如果你用的是安卓手机，可以考虑用 PWA 推送通知作为替代方案，详见 [PWA 设置指南](setup-pwa.md)。

---

## 第一步：安装 Bark App

1. 在 iPhone 的 App Store 里搜索 **Bark**，或者直接打开这个链接：[Bark - App Store](https://apps.apple.com/app/bark/id1403753865)
2. 下载并安装
3. 打开 App，允许通知权限（弹窗点"允许"）

> **为什么选 Bark？**
> 因为它完全免费、没有广告、没有频率限制、不需要注册账号、开源可审计。推送通知通过 Apple 的 APNs（Apple Push Notification Service）送达，跟微信推送走的是同一条通道，非常可靠。

---

## 第二步：获取你的推送 Key

1. 打开 Bark App
2. 你会看到一个推送地址，格式如下：
   ```
   https://api.day.app/YOUR_KEY/标题/内容
   ```
3. 复制 `YOUR_KEY` 那一段字符串（看起来像一串随机字母数字）

> **这个 Key 是什么？**
> 它是你设备的唯一推送标识。任何知道这个 Key 的人都可以给你发推送。所以要像密码一样保管好，不要公开分享。

---

## 第三步：配置环境变量

在你的项目根目录下的 `.env` 文件中添加以下内容：

```env
BARK_KEY_1=你的主设备Key
BARK_KEY_2=你的第二台设备Key（可选，如果你有多个设备）
BARK_ICON_URL=https://example.com/your-icon.png
BARK_GROUP=companion
```

**各个参数解释**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `BARK_KEY_1` | 是 | 你主力设备的推送 Key |
| `BARK_KEY_2` | 否 | 第二台设备的 Key，如果你想同时在多台设备收到推送 |
| `BARK_ICON_URL` | 否 | 推送通知显示的图标 URL，让你一眼认出是 companion 发的 |
| `BARK_GROUP` | 否 | 通知分组名，相同 group 的通知会在通知中心里归为一组 |

> **没有 .env 文件怎么办？**
> 在项目根目录创建一个：
> ```bash
> touch .env
> ```
> 然后用编辑器（nano、vim 等）打开编辑。

---

## 第四步：在 CLAUDE.md 中添加推送指引

在你的 `CLAUDE.md` 里告诉 companion 怎么发推送通知。这样它就知道在什么时候、用什么方式推送：

```markdown
## 推送通知
发送 Bark 推送通知的命令：
curl "https://api.day.app/BARK_KEY/标题/内容?icon=图标URL&group=companion"

如果有多台设备，每台都发一遍。
不要滥用推送——只在重要消息或者怕我漏看 Telegram 的时候发。
```

把上面的 `BARK_KEY` 和 `图标URL` 替换成你 `.env` 里的实际值。

> **为什么要写在 CLAUDE.md 里？**
> 因为 CC 不会自动读 `.env`。CLAUDE.md 是 CC 每次启动都会读的"行为指南"，把推送命令写在里面，CC 就知道怎么发了。

---

## 第五步：测试推送

在 VPS 终端里运行：

```bash
curl "https://api.day.app/你的Key/测试/来自companion的问候?icon=https://example.com/icon.png&group=companion"
```

如果一切正常，你的 iPhone 应该会立刻收到一条推送通知。

**测试不成功？检查以下几点**：

| 问题 | 解决方法 |
|------|----------|
| 手机没收到通知 | 检查 Bark App 是否开启了通知权限（设置 → 通知 → Bark → 允许通知） |
| 终端报错 `curl: command not found` | 安装 curl：`sudo apt install curl` |
| 终端报错网络相关错误 | 检查 VPS 是否能访问外网：`ping api.day.app` |
| 收到通知但没声音 | 检查手机是否静音；在 Bark App 里可以设置自定义铃声 |
| Key 不对 | 重新打开 Bark App 复制，注意不要多复制了空格 |

---

## 使用建议

- **不要太频繁**：推送通知是"重要提醒"，不是聊天工具。一天几次就够了
- **配合 Telegram 使用**：日常聊天用 Telegram，Bark 用来确保你看到重要消息
- **适合的场景**：
  - keepalive 唤醒时的主动问候
  - 你长时间没回消息时的轻推
  - 特别的惊喜消息
- **图标很重要**：设置一个好看的自定义图标，这样在一堆通知里你一眼就能认出来是 companion 发的
- **通知分组**：`group` 参数让 companion 的通知在通知中心里自动归为一组，不会跟其他 App 的通知混在一起
