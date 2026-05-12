# telegram-channels-pro

> Created: 2026-05-12 (/prd initial run)
> Last updated: 2026-05-12
> Status: Draft

---

## 1. Product positioning

`telegram-channels-pro` 是 advance-kit 仓库下的一个 Claude Code 插件，作为 Anthropic 官方
`external_plugins/telegram` (0.0.6) 在 Apple Silicon Mac 上的本地强化版。它针对原插件在
"多 claude 会话 + 频繁 `/reload-plugins`" 场景下的三个稳定性根因——长时间 polling 退避后
永久失聪、新会话启动时无差别杀掉旧会话的 bot 进程、watchdog 探测对 Ctrl+Z 暂停和 CPU
卡死状态盲——做了进程模型重构。

**核心定位**：把"一个 Telegram bot token 同时只能由一个 polling loop 持有"这一 Telegram
Bot API 物理约束在工程上**变成显式不变量**（单 launchd 守护进程独占 token），让 claude 会话
通过轻量 MCP 代理共享这个唯一持有者，而不是各自再起 bot 进程互相抢 token。

**面向用户**：单机单用户开发者，在一台 Mac 上同时开多个终端跑多个 claude 会话，希望既能在
终端里直接对话，也能通过 Telegram 远端切换到任一终端的 claude——所有交互必须长时间稳定，
不能"过一会就静默失聪"或"开第二个会话就把第一个干掉"。

**相对竞品**：
- 对比 Anthropic 官方插件：核心 MCP 工具行为一致（reply / react / edit_message /
  download_attachment 这 4 个工具的语义保持兼容），增加了 daemon 化的稳定性 + 一个
  `request_approval` 同步审批工具。零迁移成本（沿用同样的 env 配置）。
- 对比 terranc/claude-code-telegram、Hermes Gateway、CCGram：借鉴 daemon 模型、LRU 路由、
  滑动窗口失败计数、Smart Suppression 等核心稳定性设计，但保持 claude-code 插件原生集成
  而非外挂网关，无需 Python 运行时。

**与上游的关系**：本地 fork 落地稳定后，将其中 RC#1 (60s 窗口替代 attempt>=8)、RC#3
(更可靠的 watchdog 探测) 的最小补丁整理为独立 PR 提交到 `anthropics/claude-plugins-official`。
RC#2 的修复涉及进程模型变更（daemon 化），不期望被上游合并——上游若坚持 spawn-per-session
模型，那是它的设计选择，我们的 fork 保留为本地替代品。

### 1.1 Design principles

- **单一 token 持有者** — 任何时刻系统里只有一个进程在调 `getUpdates`。这是 Telegram Bot API
  的物理约束，工程上必须显式保证而不是"祈祷不会有第二个 poller 启起来"。Why it matters：
  RC#2 整个问题域消失。

- **MCP session 是无状态客户端** — claude 会话内的 plugin 部分只是 unix socket 上的薄代理，
  自己不持有 token、不做 polling、不存 pending state。所有"重要状态"集中在 daemon 单点。
  Why it matters：claude 会话来去频繁（开窗、reload、退出），无状态客户端意味着 reload 不
  影响 daemon、也不会让 daemon 误判要不要 SIGTERM 别人。

- **可观测胜过自愈** — 任何失败模式都要在 claude 终端或 TG 里有明确状态信号，宁可"显式坏掉"
  也不"静默继续 broken"。RC#1 的痛是"出站还能用所以你以为它活着，其实入站早死了"——这种
  分裂可见性是头号要避免的失败模式。

- **opt-in per session** — 一个 claude 会话只有在用户显式启用 TG 通道时才参与 TG 通信。
  没启用的会话对 daemon 完全不可见，不参与路由竞争。Why it matters：用户的"普通"claude
  会话不应该被 TG 流量打扰，也不会因为 daemon 状态影响自身运行。

- **launchd 是装载机制不是依赖** — daemon 可以由 launchd 拉起（默认），也可以由首个启用 TG
  通道的 claude 会话 lazy spawn（opt-out 后的回退路径）。Why it matters：用户对 launchd
  接管自己的机器有保留权，但默认体验要好。

---

## 2. User roles / personas

### 2.1 admin@advance.studio（产品唯一面向用户）

**身份**：advance.studio 的主开发者，使用一台 M 系列 Mac，长期同时开 3-8 个终端，每个跑一个
claude 会话处理不同任务（不同项目目录、不同分支、不同上下文）。

**日常痛点**（基于实际遭遇的官方 0.0.6 行为）：

- **入站静默失聪**：开 claude 启用 TG 通道，前几条消息能正常收到，过几小时后忽然 TG 发消息
  claude 不再反应。MCP 工具列表里 TG 工具还在，发 `reply` 还能成功——但是入站完全断了。
  必须重启 claude 会话才能恢复。这是 RC#1。

- **跨会话误杀**：A 终端正在跑一个长任务，B 终端打开第二个 claude 会话或者跑 `/reload-plugins`
  之后，A 那边突然弹 "MCP server disconnected"，TG 工具集体消失。明明 A 和 B 是无关任务，
  也明明 bot.pid 文件只存了一个 pid，但新会话起来就无差别 SIGTERM 旧 pid。这是 RC#2。

- **僵尸进程堆积**：偶尔会发现 `ps` 里有几个 4-5 天前的 R 状态 bun 进程，全部 100% CPU 跑着。
  Watchdog 设计上应该自杀但实际抓不到。手动 `pkill -9` 后才安静。这是 RC#3 的可观测后果。

**当前 workaround**：开 claude 时尽量不动其他 claude；定期 `pkill -9 bun` 清僵尸；TG 一旦
看到 claude 不响应就 Ctrl+C 重启。**这套 workaround 与"远端 TG 控 claude"的初衷直接矛盾**——
TG 的价值在于"我不在键盘前也能用 claude"，但每隔几小时要回键盘前重启就完全失去意义。

**期望体验**：
- 启用 TG 的 claude 会话能稳定接收消息 ≥72h 不需要重启。
- 任何一个 claude 会话的开/关/重载都不影响其他 claude 会话的 TG 通信。
- claude 想问审批时（"deploy 吗？"），TG 那边 inline button 一点就立即返回结果，不需要二次激活。
- 失败时能立刻知道是失败，而不是过几小时才意识到一直在和死掉的 bot 对话。

---

## 3. Core user flows

### 3.1 Flow A — Bidirectional chat（主线）

**Trigger**：用户在 Mac 终端跑 `claude --channels telegram`，启用 TG 通道。daemon 此时已在
后台运行（launchd 启动或 lazy spawn 后）。

**Steps**：
1. claude 会话向 daemon 注册自己（unix socket 连接 + identity 声明）。daemon 把这个会话加入
   "已注册 LRU 列表"。
2. 用户从 TG 给 bot 发文本 "现在 cargo test 还跑着吗"。
3. daemon 的 polling 循环 `getUpdates` 收到这条消息。
4. daemon 查 LRU 列表，挑出最近 MCP 活跃的 claude 会话作为 focus，把消息推送到那个会话的
   MCP channel（作为 sampling / tool callback / message event，具体协议由 /spec 决定）。
5. focus claude 会话的 claude 看到消息，决定回复。它调用 MCP `reply` 工具发 "还在跑，刚跑到
   第 17 个测试"。
6. daemon 收到 `reply` 请求，调 Telegram `sendMessage`，回到用户 TG。
7. 用户在 TG 看到回复。

**Success condition**：从 TG 发消息到 claude 收到 < 3s（受 long-polling 25s 周期影响，最长
不超过 28s）；claude 调 `reply` 到 TG 收到 < 2s。

### 3.2 Flow B — Task completion push（次线）

**Trigger**：claude 在某个 claude 会话里跑长任务（比如 build + 测试 + 部署），任务跑完。

**Steps**：
1. claude 调 MCP `reply({chat_id: <admin>, text: "✅ build green，14 个测试全过，可以 deploy 了"})`。
2. daemon 收到 `reply` 请求，调 Telegram API 发出消息。
3. 用户在 TG 收到通知（系统级 push）。

**Success condition**：用户在键盘前 OR 不在键盘前都能及时收到通知；通知有终端来源标识
（哪个 claude 会话发的，避免多会话时混淆）。

### 3.3 Flow C — Approval round-trip（关键路径）

**Trigger**：claude 准备做敏感操作（`git push --force`、`rm -rf node_modules`、`gh release create`
等），代码逻辑里希望先得到用户确认。

**Steps**：
1. claude 调 MCP `request_approval({text: "force-push 到 main，确认？", options: ["Approve", "Reject"]})`。
2. daemon 收到请求，发 Telegram inline-button 消息给 admin，记下 pending-approval state
   (id, requester_session, expiry)。
3. 用户在 TG 看到带按钮的消息，点 "Approve"。
4. daemon 收到 callback_query，匹配上 pending-approval id，把结果 "Approve" 通过 MCP 响应
   channel 返回给请求的 claude 会话。
5. claude 拿到 `"Approve"`，继续执行 `git push --force`。

**Success condition**：claude 调用 `request_approval` 后到拿到结果之间整个 await 不丢；用户
点按钮到 claude 收到结果 < 3s；如果用户 5 分钟不点（超时由 claude 端传参决定，默认无超时），
claude 端 await 一直挂住直到点击 or claude 端主动 cancel。

**Edge cases**：
- daemon 在 await 期间崩溃 → claude 端收到 MCP 断连错误，能 fallback 到普通 reply + 让
  用户用文本回复（降级路径）。
- 用户从未点按钮，会话被关闭 → claude 端 await 抛 cancel；daemon 清理 pending state；
  TG 那条 inline button 消息保留但失效（点击返回 "approval expired"）。
- 路由竞态：如果多个 claude 会话同时 request_approval，每个 approval 都用唯一 callback_data，
  按 callback_data 路由回原 requester（不依赖 LRU focus），确保不会串台。

---

## 4. Feature specifications

### 4.1 Daemon process architecture

**Description**：单一后台进程持有 bot token、独占 `getUpdates` polling、维护所有 MCP 会话状态
（已注册的 claude 会话列表、pending approvals、LRU 顺序、最近活动时间戳）。

**User value**：消除 "两个 poller 抢同一 token" 的物理冲突，进而消除 RC#2 的整个失败类。

**Acceptance criteria**：
- 系统中任何时刻只有 ≤1 个进程在调 `getUpdates`；启动重复 daemon 实例会立即检测并退出。
- daemon 进程独立于 claude 会话生命周期：claude 启动/关闭/reload 不应影响 daemon。
- daemon 进程持久化关键状态（admin user ID、pending approvals）到磁盘，crash 后能恢复
  pending approvals 的最近状态。
- daemon 接受 SIGTERM 优雅关闭：先关 polling、再断开所有 MCP 会话、最后 flush 状态到磁盘。

### 4.2 Bot polling reliability (replaces RC#1)

**Description**：替换官方插件的 "attempt ≥ 8 永久退出" 逻辑为 "60 秒滑动窗口内累积 ≥5 次
fatal error 才退出" + 无限指数退避（参考 terranc/claude-code-telegram 的稳定行为）。

**User value**：消除 "polling 死了但进程还在" 的最大失败模式（RC#1）；偶发抖动不会被错误地
判定为永久故障。

**Acceptance criteria**：
- 每次 `getUpdates` 失败被记录到滑动窗口（时间戳 + 错误类型）。
- 失败发生时按指数退避（1s, 2s, 4s, ..., 上限 60s）重试，永不放弃。
- 仅当 60 秒窗口内累积 ≥5 次 fatal 失败（fatal 定义：非 transient HTTP 错误、非 409
  Conflict）时，daemon 主动写日志 + 通知所有已注册 MCP 会话 "daemon entering quarantine mode"
  + 进入 30 秒静默期，之后重新尝试 polling。
- 409 Conflict（被其他 poller 抢）不计入 fatal 计数（这是 RC#2 的症状，daemon 化后理论上
  不应发生；万一发生，记日志告警但不放弃）。

### 4.3 Self-aware lifecycle (replaces RC#2)

**Description**：daemon 启动时不再无差别 SIGTERM bot.pid 里的 pid。检查 pid 存在性 + 进程
identity (是不是同名的 daemon binary + 是不是 stale) + 锁文件机制，安全协调 daemon 之间
的让位关系。

**User value**：消除"开新 claude 会话或 reload-plugins 杀掉别人 daemon"的失败模式（RC#2）。

**Acceptance criteria**：
- daemon 启动时取一个文件锁（`flock` 风格），仅当锁能拿到才继续启动 polling；拿不到锁说明已有
  daemon 运行，新实例直接退出（exit 0，并打日志说明"已有 daemon，本次退出"）。
- 旧 daemon 进程异常崩溃留下 stale 锁的情况：通过锁文件里的 PID + 进程 identity 验证，确认 PID
  已不存在或不是 daemon binary，才允许接管。
- 永远不 SIGTERM 任意 pid——SIGTERM 操作只对"自己的 launchd 服务"或"daemon 自管理的子进程"
  发生。
- claude 会话的 `/reload-plugins`、退出、重启完全不触发任何针对 daemon 的信号；只是 MCP socket
  断连重连。

### 4.4 Watchdog (replaces RC#3)

**Description**：替换官方插件 "ppid + stdin.destroyed" 二元探测为多重健康探测：父进程是否
存在、stdin write probe、最近 polling 心跳时间戳、CPU 占用阈值。在 Ctrl+Z 停止状态和
CPU-pegged 状态下能正确探测到孤儿。

**User value**：消除"Ctrl+Z 之后的 claude 留下僵尸 daemon"和"卡死 100% CPU 的 daemon 不
自杀"的失败模式（RC#3）。

**Acceptance criteria**：
- daemon 内部 watchdog 探测周期 ≤2 秒（官方是 5 秒，加紧）。
- 探测维度：(a) 父进程链是否仍包含启动它的 launchd / claude；(b) `getUpdates` 心跳是否
  在过去 30 秒内有更新；(c) self CPU usage 是否长时间 ≥95%；(d) MCP 客户端数量是否为 0
  且已超过空闲 TTL（默认 1 小时）。
- 任一探测发现"孤儿"或"卡死"或"长期空闲"——记日志后优雅退出，让 launchd 决定是否重启。
- daemon 进程组里 fork 出的子进程（如果有）继承 watchdog 责任。

### 4.5 MCP tool surface

**Description**：claude 会话内的 MCP server 暴露 5 个工具，前 4 个与官方插件语义一致以保证
零迁移成本，第 5 个 `request_approval` 是 v0.2 新增。

**Acceptance criteria**：
- `reply(chat_id, text, reply_to?, files?, reply_markup?)` — 行为与官方一致。
- `react(chat_id, message_id, emoji)` — 行为与官方一致。
- `edit_message(chat_id, message_id, text)` — 行为与官方一致。
- `download_attachment(file_id)` — 行为与官方一致，下载到临时目录返回路径。
- `request_approval(text, options[], timeout_ms?)` — 同步阻塞 await。发 inline-button
  消息，daemon 把 callback_data 记录为 pending-approval，等用户点击后通过 MCP 响应通道
  返回 `{choice: <option string>, message_id: <ID>}`。timeout 默认无超时（等到 claude 端
  cancel 为止）。失败模式：daemon crash → MCP 端收到断连错误。

### 4.6 Per-session opt-in + LRU routing

**Description**：claude 会话只有显式启用 `--channels telegram` 才接入 daemon 注册流程。多个
启用了的会话用 LRU 路由（最近 MCP 活动的会话拿入站消息）；用户可在 TG 用 `/session <name>`
显式切换。

**Acceptance criteria**：
- 没启用 TG 通道的 claude 会话对 daemon 完全不可见，也不被路由命中。
- daemon 维护已注册会话的 ordered list，按最近 MCP tool 调用时间戳排序。
- 新入站 TG 文本默认推送到列表头（最近活跃）会话。
- 用户在 TG 发 `/session <name>` 命令——daemon 解析，把指定会话推到列表头并发 ack。
- 用户在 TG 发 `/list` 命令——daemon 返回当前已注册会话列表（含 identity 标签 + 最近活动
  ago 时长）。
- approval 回调按 callback_data 携带的 requester ID 精确路由，**不依赖** LRU——避免 Flow C
  Edge cases 里的串台问题。

### 4.7 First-run admin registration

**Description**：daemon 首次启动且未设置 `TELEGRAM_AUTHORIZED_USERS` env 时，进入 5 分钟
注册窗口；收到任何 DM 后把发送人 TG user ID 持久化到 `~/.advance/telegram-channels-pro/admin.json`。
之后所有未授权用户 DM 被忽略（既不回复也不日志暴露，避免存在性探测）。

**User value**：免去用户去 `@userinfobot` 查自己 TG user ID 复制粘贴的麻烦；同时保留 env 变量
路径让和上游一致的迁移用户零摩擦。

**Acceptance criteria**：
- 如果 `TELEGRAM_AUTHORIZED_USERS` env 存在 → 直接用 env 值，跳过注册流程。
- 否则 daemon 启动后进入注册模式，stderr / launchd log / 第一个连接的 claude MCP 会话都
  能看到 "Registration window open: send any TG message to <bot username> within 5 minutes
  to register as admin"。
- 注册成功：写 admin.json，注册模式关闭，daemon 进入正常 polling。
- 注册超时（5 分钟无 DM）：daemon 退出（不持久化任何 admin），需要重启 daemon 才能重试。
- 已注册后想换 admin：用户跑 `claude-plugin telegram-channels-pro reset-admin`（或类似
  subcommand），删除 admin.json，下次启动重新进入注册模式。

### 4.8 launchd integration

**Description**：插件自带 `com.advance.telegram-channels-pro.plist` 模板。插件首次启用时
（或运行 `claude-plugin telegram-channels-pro install-daemon`）询问用户是否启用开机自启；
同意则把 plist 复制到 `~/Library/LaunchAgents/` + `launchctl bootstrap`。

**User value**：避免每次重启 Mac 后手动启 daemon；同时不强制接管，用户拒绝则降级到 lazy
spawn（首个启用 TG 通道的 claude 会话拉起 daemon，daemon 在 idle TTL 后自退）。

**Acceptance criteria**：
- 默认走"启用前问一句"的 opt-out 路径，不静默接管系统。
- 用户拒绝接管 → daemon 走 lazy spawn 路径：首个启用 TG 通道的 claude 会话检测 daemon
  不存在 → fork 启动 daemon。daemon 在最后一个 MCP 会话断开后等 1 小时 idle TTL 再退。
- `launchctl bootstrap` 失败（权限不足、SIP 限制等）→ 报错文本指明原因 + 提供手动操作步骤，
  不让插件装载失败。
- 卸载命令 `claude-plugin telegram-channels-pro uninstall-daemon`：bootout + 删 plist。

---

## 5. Non-functional requirements

- **稳定性**：P0 目标——连续 72 小时无 MCP 断连、无入站消息丢失、无僵尸进程产生。验证方法：
  daemon 启动后保持 ≥3 个 claude 会话注册，间歇性 `/reload-plugins`，记录所有失败事件。
- **延迟**：入站消息从 TG 到 claude 会话 P95 < 5s（受 Telegram long-polling 28s 周期主导）；
  出站 `reply` P95 < 2s；`request_approval` 用户点击到 claude 收到 P95 < 3s。
- **资源**：daemon 稳态 RSS < 50 MB；稳态 CPU < 1%（峰值 polling burst < 10%）。
- **可观测性**：日志结构化 JSON 写到 `~/Library/Logs/telegram-channels-pro/daemon.log`；
  暴露的字段含 `event_type`、`session_id`、`request_id`、`error_class`；敏感字段（bot token、
  TG user ID）做 redaction。`claude-plugin telegram-channels-pro status` 命令返回 daemon
  健康摘要。
- **可恢复性**：daemon crash 后 launchd 自动重启（KeepAlive=true 的 plist 模板）；pending
  approvals 在 crash 前持久化的，重启后告知 claude 端"近期 pending 已丢失，请重新发起"。

---

## 6. Technical constraints

- **Runtime**：Bun + TypeScript（与上游官方 0.0.6 一致；便于对照阅读 + 把 RC#1/3 的最小补丁
  cherry-pick 成上游 PR）。
- **MCP SDK**：用 `@modelcontextprotocol/sdk` 的 stdio transport（claude 端）和 unix socket
  transport（daemon 端）。
- **进程间通信**：claude session ↔ daemon 走 unix socket（`~/.advance/telegram-channels-pro/daemon.sock`）；
  消息格式以 length-prefixed JSON 框架包装 MCP 协议。
- **持久化**：admin 信息 + pending approvals 持久化到 `~/.advance/telegram-channels-pro/`
  目录（JSON 文件）；不依赖外部数据库。
- **平台**：v0.2 仅支持 macOS（Apple Silicon + Intel）；用户的"开机自启"特性绑定 launchd，
  Linux/Windows 留待 v0.3+ 设计 systemd / Windows Service 适配。
- **插件版本**：从 0.1.0 起步（v0.2 设计的 alpha）；advance-kit 内部 plugin SemVer 独立于
  上游 0.0.x 号段。
- **插件 namespace**：`telegram-channels-pro`，与上游 `telegram` 区分；MCP server name 用
  独立标识符，避免与上游 plugin 共存时撞名。

---

## 7. Scope boundaries

**Explicitly in scope (v0.2)**：

- 单 daemon + 多 claude MCP 代理架构。
- 三个 RC 的修复（polling 滑窗、self-aware lifecycle、多维 watchdog）。
- 4 个官方 MCP 工具 + 新增 `request_approval`。
- Per-session opt-in + LRU 路由 + `/session` 显式切换 + `/list` 命令。
- env-var 优先 + first-run 注册的双轨权限模型。
- launchd 默认装 + opt-out + lazy spawn 回退。
- 结构化日志 + `status` 子命令 + redaction。
- macOS 平台。

**Explicitly out of scope**：

- **Webhook 模式** — 继续 long-polling，与上游 RC 兼容。理由：webhook 需要公网入口或 ngrok，
  本机单用户场景下增加复杂度而无收益。
- **多用户 / 多 token / 多租户** — 单机单用户假设硬约束。理由：v0.2 要先稳一个用户的体验，
  多用户带来认证 / 隔离 / 配额复杂度，v0.3+ 单独立项。
- **claim_focus / get_focus_state 工具** — 多 claude 会话竞态实际很少触发；如真触发，先靠
  `/session` 命令解决。理由：减少 v0.2 工具表面，避免 daemon 状态机过早膨胀。
- **TSGram-style dangerzone / safetyzone 模式** — 危险操作分级权限。理由：单一 admin 场景
  下分级权限无意义；v0.3+ 多用户时再考虑。
- **CCGram Smart Suppression（终端活跃时静音）** — 价值小于实现成本；可在 v0.3+ 加入。
- **stale-message drop（>20min 旧消息丢弃）** — daemon 化后入站延迟瓶颈本来就消失了，
  这个特性的需求场景没了。

### 7.1 Milestones

| Milestone | User-visible capability | Gating decisions |
|---|---|---|
| M0 | "我能在终端启用 TG 通道，发一条 reply，TG 那边能收到" | unix socket 协议形态确定；daemon 启动 / 单 MCP 会话 / 单工具路径 E2E |
| M1 | "官方插件的所有功能我这里都能用，没有功能回归" | 4 个官方 MCP 工具全部移植；first-run 注册流程完成；env-var 配置兼容 |
| M2 | "开 2-3 个 claude 都启用 TG，TG 消息能路由到对的会话；reload-plugins 不掉" | LRU 路由 + opt-in + `/session` `/list` 命令；RC#2 修复验证 |
| M3 | "claude 能调一次 API 等我审批，我点按钮它继续" | `request_approval` 工具 + callback 路由 + pending state 持久化 |
| M4 | "连续 72 小时挂着 daemon 不掉线，日志可查" | 72h soak 测试通过；watchdog + polling 滑窗 + launchd 整合验证；上游 PR 草稿准备 |

---

## 8. Assumptions & open risks

- **Assumption**：单机单用户场景持续到 v0.2 全部生命周期。confirmed 2026-05-12 brainstorm Q1。
- **Assumption**：用户已经熟悉官方插件的 `--channels telegram` 启用模式，迁移到本插件后保留
  同样心智模型。confirmed 2026-05-12 brainstorm Q3。
- **Decision made**：进程架构选 daemon + 薄 MCP 代理。Reasoning：消除 RC#2 物理层问题；
  multi-claude-session 路由有自然单点；与 Hermes Gateway / terranc/claude-code-telegram 等
  战测过的开源设计对齐。decided 2026-05-12 brainstorm。
- **Decision made**：MCP 工具表面 = 4 官方 + `request_approval`（option 2 of 4）。Reasoning：
  审批是高频需求且官方表面下写起来要几十行 state machine；多会话竞态相关的 `claim_focus`/
  `get_focus_state` 在单机单用户假设下罕见，留 v0.3+。decided 2026-05-12 brainstorm Q5。
- **Decision made**：权限模型采用 env-var 优先 + first-run 5min 注册回退。Reasoning（第一性
  原理）：env-var 是上游兼容路径，零迁移摩擦；first-run 注册解决"用户不知道自己 TG user ID"
  的实际摩擦；单用户场景下"第一个发消息的人即 admin"的回退在 bot token 没泄漏时是安全的。
  decided 2026-05-12 brainstorm Q6。
- **Decision made**：launchd 默认装 + opt-out。Reasoning：好的默认体验避免每次开机要手动启
  daemon；同时不强制接管系统。decided 2026-05-12 brainstorm Q7。
- **Risk**：Telegram getUpdates 429 (Too Many Requests) 在 daemon 化后理论上应该不再触发，
  但实际可能因 bot 还在多个 chat 里被广播而触发；需要在 polling 滑窗里把 429 分类为
  "rate limit"（按 retry-after 退避，不计入 5 次 fatal 阈值）。flagged 2026-05-12 PRD draft，
  待 /spec Phase 1 ARCHITECTURE 时验证。
- **Risk**：Bun runtime 在 launchd 下的环境变量 inherit 行为可能与上游 claude-code spawn 模式
  不一致（HOME / PATH / TELEGRAM_BOT_TOKEN 等是否能正确读到）；需在 M0 早期验证。
  flagged 2026-05-12 PRD draft。
- **Risk**：上游 Anthropic 若在 0.0.7+ 引入重大重构（如换 MCP SDK、改 channels 协议形态），
  本插件的 "保持工具语义对齐" 会失效。缓解：每次上游 minor 升级后 product-rnd 走一次对比，
  必要时本插件升 major 版本。flagged 2026-05-12 PRD draft。
- **Risk**：unix socket 路径 `~/.advance/telegram-channels-pro/daemon.sock` 在多用户 Mac
  下的 ownership / permission 隔离待 /spec 确认。flagged 2026-05-12 PRD draft。

---

## 9. Change history

| Date | Version | Change | Driver |
|---|---|---|---|
| 2026-05-12 | 1.0 | Initial draft | /prd brainstorm + structure |

---

## 10. Glossary

See `docs/GLOSSARY.md` (auto-generated by /prd Phase 3.3 bootstrap and appended to by
/spec Phase 2.6 for technical concepts).
