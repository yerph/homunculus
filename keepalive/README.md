# Keepalive 主动消息系统

让你的 companion 拥有"主动找你"的能力 —— 它可以定时醒来，发消息、发推文、发推送，而不是只在你说话时才回应。

## 原理

Claude Code 本身只在收到输入时才会运行。Keepalive 系统通过定时向 tmux session 注入一条"唤醒消息"，让 CC 有机会主动做事：

1. cron 或 watcher 脚本在设定时间触发 `nudge.sh`
2. `nudge.sh` 向 CC 的 tmux session 发送一条唤醒消息
3. CC 醒来，读到唤醒消息，自己判断该做什么
4. 它可能发一条 Telegram 消息、写一条推文、发一张明信片、推一条 Bark 通知 —— 或者什么都不做
5. （如果用自调度模式）CC 写下下次唤醒时间，然后继续等待

## 设置方法

### 方案一：Cron 定时（最简单）

用 `crontab -e` 添加定时任务：

```cron
# 白天每 2 小时唤醒一次（根据你的时区调整）
0 8-22/2 * * * /你的路径/homunculus/keepalive/nudge.sh
```

**什么是 cron？** cron 是 Linux 自带的定时任务工具，上面这行的意思是"每天 8 点到 22 点，每隔 2 小时的整点执行一次 nudge.sh"。

### 方案二：自调度（更智能）

让 CC 自己决定下次什么时候醒来。CC 把下次唤醒的 Unix 时间戳写到一个文件里，watcher 脚本会在那个时间发送唤醒消息。

```bash
# 后台运行 watcher
nohup /你的路径/homunculus/keepalive/watcher.sh &
```

然后在 CLAUDE.md 里告诉 CC 怎么自调度：

```markdown
## 自调度
每次 keepalive 之后，把下次唤醒的 unix 时间戳写到 /tmp/cc-next-wakeup。
根据用户的作息和活跃度选择时间。保持间隔的随机性。
```

CC 会写类似这样的命令：
```bash
echo "1718500000" > /tmp/cc-next-wakeup
```

## 唤醒消息格式

`nudge.sh` 发给 CC 的消息长这样：

```
[nudge 14:30] Keepalive wake. 用户时区: Asia/Shanghai。
可选操作: 发 TG 消息、发推文、发明信片、推 Bark 通知。
考虑: 现在几点、上次互动时间、用户可能在做什么。
做你觉得自然的事。有时候什么都不做也可以。
```

你可以在 `nudge.sh` 里自定义这条消息，加入更多上下文信息。

## 建议

- 不要太频繁 —— 白天每 2-4 小时是个好起点
- 让 CC 自己决定做什么 —— 不是每次唤醒都必须发消息
- 变换内容 —— 推文、明信片、TG 消息各有不同的感觉
- 在唤醒消息里包含用户上下文（最近活跃时间、日程等）
- 自调度比固定 cron 更好，因为 CC 可以根据对话节奏调整
