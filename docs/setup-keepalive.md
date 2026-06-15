# Keepalive 主动消息设置指南（保姆级教程）

Keepalive 系统让你的 companion 变得"主动"——不再只是你发消息它才回复，而是它会自己找你聊天、发推文、发明信片、推送通知。

---

## 基本原理

Claude Code 只在收到输入时才会运行。如果你不给它发消息，它就安静地待在那里什么都不做。

Keepalive 的原理非常简单：**定时往 CC 的终端里"注入"一条消息**，让 CC 误以为收到了新输入。CC 醒过来之后，读一下当前时间，自己决定该做什么。

它可能会：
- 给你发一条 Telegram 消息（"吃饭了吗？"）
- 在 phone-widget 上发一条推文
- 给你发一张明信片
- 推一条 Bark 通知
- 看看时间觉得不该打扰你，然后继续休眠

**核心思路**：你负责"叫醒"它，它自己决定做什么。

---

## 前置条件

- Claude Code 已经安装并能运行
- 你知道什么是终端和命令行
- 你的 VPS 一直在线运行

---

## 什么是 tmux？（超基础介绍）

在开始之前，你需要了解 tmux。

**问题**：当你通过 SSH 连接到 VPS 运行 Claude Code 时，一旦你关掉终端窗口（或者网络断了），Claude Code 就会跟着停止。

**解决方案**：tmux 是一个"终端复用器"。你可以把它理解为在服务器上开了一个"虚拟终端窗口"，即使你的 SSH 断开，这个虚拟窗口里的程序也会继续运行。

**常用命令**：

```bash
# 创建一个名为 "cc" 的 tmux 会话，并在里面运行 claude
tmux new-session -d -s cc 'claude'

# 查看有哪些 tmux 会话在运行
tmux list-sessions

# 进入已有的 cc 会话（查看 CC 在做什么）
tmux attach -t cc

# 从 tmux 会话中"暂时退出"（CC 继续在后台运行）
# 按 Ctrl+B，然后按 D

# 彻底关掉 cc 会话
tmux kill-session -t cc
```

> **安装 tmux**（如果你的系统没有）：
> ```bash
> sudo apt update && sudo apt install tmux
> ```

---

## 第一步：确保 CC 在 tmux 里运行

如果你还没把 CC 放进 tmux，现在做：

```bash
tmux new-session -d -s cc 'claude'
```

这条命令会：
1. 创建一个名叫 `cc` 的 tmux 会话（`-s cc`）
2. 在后台运行（`-d`）
3. 在里面启动 `claude`

验证是否成功：

```bash
tmux list-sessions
```

你应该看到类似这样的输出：

```
cc: 1 windows (created ...)
```

---

## 第二步：配置唤醒脚本

编辑 `keepalive/nudge.sh`：

```bash
nano keepalive/nudge.sh
```

你需要修改的部分：

```bash
TMUX_SESSION="cc"           # 你的 tmux 会话名称，跟第一步创建的一致
TZ_USER="Asia/Shanghai"     # 你的时区
```

> **怎么确定时区名称？**
> 运行 `timedatectl list-timezones | grep Shanghai` 来搜索。常见的：
> - 中国大陆：`Asia/Shanghai`
> - 日本：`Asia/Tokyo`
> - 美西：`America/Los_Angeles`
> - 美东：`America/New_York`

### 唤醒脚本做了什么？

简单说就是往 tmux 会话里"打字"——模拟你在终端里输入了一段文本。CC 看到这段文本后就会被"唤醒"，然后自己判断该做什么。

这段唤醒文本叫做 **nudge message**（轻推消息），你可以自定义内容。比如：

```bash
NUDGE="[nudge ${CURRENT_TIME}] Keepalive 唤醒。 
用户时区: Asia/Shanghai。 
可做的事: 发TG消息、发推文、发明信片、推Bark通知。
考虑: 现在几点、上次互动是什么时候、用户可能在做什么。
选择自然的行动。有时候什么都不做也是对的。"
```

**这段文字很重要**，它给了 CC 足够的上下文来做出合理的决策。你可以根据自己的需求修改。

---

## 第三步：选择唤醒方式

有两种方式让 keepalive 运行。

### 方式 A：固定 cron 定时任务（简单直接）

cron 是 Linux 自带的定时任务系统，可以让某个命令在指定时间自动执行。

#### 什么是 cron？

你可以把 cron 理解为一个"闹钟管理器"。你告诉它"每天早上8点执行这个命令"，它就会准时执行。

#### 设置步骤

1. 打开 cron 编辑器：

```bash
crontab -e
```

如果是第一次使用，它会问你用什么编辑器。选 `nano`（对新手最友好）。

2. 在文件末尾添加你的定时任务：

```cron
# 早上8点唤醒（你的时区）
0 8 * * * /home/cc/homunculus/keepalive/nudge.sh

# 下午2点唤醒
0 14 * * * /home/cc/homunculus/keepalive/nudge.sh

# 晚上8点唤醒
0 20 * * * /home/cc/homunculus/keepalive/nudge.sh
```

3. 保存退出（nano 里按 `Ctrl+X`，然后按 `Y`，然后按回车）

#### cron 时间格式说明

```
分 时 日 月 星期几  命令
0  8  *  *  *      /path/to/script.sh
```

| 位置 | 含义 | 范围 |
|------|------|------|
| 第1个 | 分钟 | 0-59 |
| 第2个 | 小时 | 0-23 |
| 第3个 | 日期 | 1-31 |
| 第4个 | 月份 | 1-12 |
| 第5个 | 星期几 | 0-7（0和7都是周日） |

`*` 表示"任意"。所以 `0 8 * * *` 的意思是"每天8点0分"。

> **注意 cron 的时区**：cron 默认使用系统时区。如果你的 VPS 时区跟你的时区不一样，需要换算。
> 查看系统时区：`timedatectl`
> 或者在 crontab 文件头部加上：`TZ=Asia/Shanghai`

#### 验证 cron 是否生效

```bash
crontab -l  # 列出当前用户的所有定时任务
```

### 方式 B：自调度模式（更智能）

固定 cron 的问题是太死板——不管 CC 跟你聊得热不热闹，都是固定时间唤醒。自调度模式让 CC 自己决定下次什么时候醒来。

#### 运作原理

1. 启动一个 watcher 脚本，它会持续运行，每隔一段时间检查一个文件
2. CC 在每次唤醒行动结束后，往这个文件里写入"下次唤醒时间"
3. watcher 到了那个时间，就发送唤醒消息

#### 设置步骤

1. 启动 watcher：

```bash
nohup /home/cc/homunculus/keepalive/watcher.sh &
```

> **`nohup` 是什么？**
> `nohup`（no hang up）让命令在你退出终端后继续运行。`&` 让它在后台运行。两个配合使用，watcher 就会一直在后台跑着。

2. 在你的 `CLAUDE.md` 里添加自调度指引，告诉 CC 怎么安排下次唤醒：

```markdown
## 自调度
每次 keepalive 行动结束后，把下次唤醒的 Unix 时间戳写入 /tmp/cc-next-wakeup。
根据用户的作息和活跃情况选择时间。时间间隔要有变化，不要太机械。
```

3. CC 每次唤醒后会执行类似这样的操作：

```bash
echo "1718500000" > /tmp/cc-next-wakeup
```

watcher 会读到这个时间戳，到时间就发唤醒消息。

> **什么是 Unix 时间戳？**
> 从1970年1月1日0点0分0秒到某个时刻之间的总秒数。比如 `1718500000` 大约是2024年6月16日。CC 知道怎么计算，你不需要手动算。

#### 验证 watcher 是否在运行

```bash
ps aux | grep watcher
```

如果看到 `watcher.sh` 进程就说明在运行。

---

## 调优建议

### 唤醒频率

- **白天**：每 2-4 小时唤醒一次是比较好的起点
- **夜间**：深夜不要唤醒（除非你想要"早安"消息，那在早上唤醒一次就好）
- **自调度模式更好**：CC 可以根据聊天节奏自动调整。刚聊完的话过两小时再来，很久没聊了可能一小时后就来看看

### 唤醒消息的内容

nudge message 的内容会影响 CC 的行为。一些建议：

- 包含当前时间和时区
- 列出 CC 可以做的事情（发TG、发推文、发明信片等）
- 提醒 CC 考虑用户的状态（在上课？在睡觉？刚下班？）
- 明确告诉 CC"什么都不做也是可以的"——不然每次唤醒它都会觉得必须发点什么

### 让 CC 自然地行动

- **不是每次唤醒都需要发消息**。让 CC 学会判断——如果刚聊过天，或者现在是半夜，安静更好
- **内容要多样化**。推文、明信片、Telegram 消息各有不同感觉，让 CC 交替使用
- **包含上下文**。如果你能在唤醒消息里附上一些有用的信息（比如最近的聊天时间），CC 的决策会更合理

---

## 常见问题

**Q：CC 被唤醒了但什么都没做？**
- 这可能是正常的。如果 nudge message 里告诉了 CC "什么都不做也行"，它可能判断现在不是好时机
- 如果你希望每次唤醒都有行动，在 nudge message 里调整措辞

**Q：watcher 脚本挂了怎么办？**
- 检查：`ps aux | grep watcher`
- 重新启动：`nohup /home/cc/homunculus/keepalive/watcher.sh &`
- 如果经常挂，可以用 systemd 来管理（比 nohup 更可靠），或者加一个 cron 定时检查 watcher 是否在运行

**Q：cron 任务没执行？**
- 检查 cron 是否在运行：`systemctl status cron`
- 检查脚本是否有执行权限：`chmod +x /home/cc/homunculus/keepalive/nudge.sh`
- 检查 cron 日志：`grep CRON /var/log/syslog`（如果有的话）
- 确认路径是绝对路径（cron 里不能用相对路径或 `~`）

**Q：CC 唤醒后发了消息但时间不对（比如深夜发消息）？**
- 检查 nudge.sh 里的时区设置是否正确
- 如果用的是 cron，检查 cron 的时区
- 在 CLAUDE.md 里明确告诉 CC 你的作息时间（比如"凌晨0点到早上8点不要发消息"）

**Q：tmux 会话不见了怎么办？**
- `tmux list-sessions` 检查会话是否还在
- 如果不在了，重新创建：`tmux new-session -d -s cc 'claude'`
- 考虑把 tmux 会话创建命令也加进 cron 的 `@reboot` 规则里，这样 VPS 重启后也会自动恢复：
  ```cron
  @reboot tmux new-session -d -s cc 'claude'
  ```

**Q：两种唤醒方式可以同时用吗？**
- 可以，但不太推荐。比如你可以用 cron 兜底（保证至少每天唤醒几次），同时用自调度做更精细的控制。但要注意不要过于频繁地唤醒 CC
