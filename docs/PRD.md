# telegram-channels-pro

> Created: 2026-05-12 (/prd initial run)
> Last updated: 2026-05-15
> Status: Draft

---

## 1. Product positioning

`telegram-channels-pro` 是 advance-kit 仓库下的一个 Claude Code 插件，作为 Anthropic 官方
`external_plugins/telegram` (0.0.6) 在 Apple Silicon Mac 上的本地强化版。它针对原插件在
"多 claude 会话 + 频繁 `/reload-plugins`" 场景下的三个稳定性根因——长时间 polling 退避后
永久失聪、新会话启动时无差别杀掉旧会话的 bot 进程、watchdog 探测对 Ctrl+Z 暂停和 CPU
卡死状态盲——做了进程模型重构。

**核心定位**：把"一个 Telegram bot token 同时只能由一个 polling loop 持有"这一 Telegram
Bot API 物理约束在工程上**变成显式不变量**（单守护进程独占 token），让 claude 会话通过
轻量 MCP 代理共享这个唯一持有者，而不是各自再起 bot 进程互相抢 token。

**面向用户**：单机单用户开发者，在一台 Mac 上同时开多个终端跑多个 claude 会话，希望既能在
终端里直接对话，也能通过 Telegram 远端切换到任一终端的 claude——所有交互必须长时间稳定，
不能"过一会就静默失聪"或"开第二个会话就把第一个干掉"。

**单子系统范围**：本 PRD 涵盖的"telegram-channels-pro 插件"作为单一可部署单元，包括 daemon
进程本体 + claude 会话内 MCP 代理 + 安装/卸载/配置子命令 + launchd plist 模板及其装载协调。
launchd 集成（§4.8）是 daemon 部署机制的一部分，不是独立子系统——只是把"如何把 daemon 拉
起来"这件事变成了用户可选的 opt-in。

**相对竞品**：
- 对比 Anthropic 官方插件：核心 MCP 工具的**外部行为**保持兼容（reply / react /
  edit_message / download_attachment 这 4 个工具在调用方看来语义一致），增加了 daemon 化的
  稳定性 + 一个 `request_approval` 同步审批工具。零迁移成本（沿用同样的环境变量配置）。
- 对比 terranc/claude-code-telegram、Hermes Gateway、CCGram：借鉴 daemon 模型、LRU 路由、
  滑动窗口失败计数等核心稳定性思想，但保持 claude-code 插件原生集成而非外挂网关。

**与上游的关系**：本地 fork 落地稳定后，将其中 polling 永久放弃 (RC#1) 和 watchdog
误判 (RC#3) 这两类的最小补丁整理为独立 PR 提交到 `anthropics/claude-plugins-official`。
SIGTERM 互杀 (RC#2) 的修复涉及进程模型变更（daemon 化），不期望被上游合并——上游若坚持
spawn-per-session 模型，那是它的设计选择，我们的 fork 保留为本地替代品。

### 1.1 Design principles

- **单一 token 持有者** — 任何时刻系统里只有一个进程在调 `getUpdates`。这是 Telegram Bot
  API 的物理约束，工程上必须显式保证而不是"祈祷不会有第二个 poller 启起来"。Why it matters：
  RC#2 整个问题域消失。

- **MCP session 是无状态客户端** — claude 会话内的 plugin 部分只是薄代理，自己不持有 token、
  不做 polling、不存 pending state。所有"重要状态"集中在 daemon 单点。Why it matters：claude
  会话来去频繁（开窗、reload、退出），无状态客户端意味着 reload 不影响 daemon、也不会让
  daemon 误判要不要 SIGTERM 别人。

- **失败可观测，正常生命周期静默** — 任何**失败**（polling 异常、watchdog 触发、auth 拒绝、
  daemon crash）都要在 claude 终端或 TG 里有明确状态信号，避免"出站还能用所以你以为活着，
  其实入站早死了"这种分裂可见性。而**正常**生命周期事件（idle 自退、launchd 计划重启）不
  打扰用户。两者必须区分清楚。

- **opt-in per session** — 一个 claude 会话只有在用户显式启用 TG 通道时才参与 TG 通信。
  没启用的会话对 daemon 完全不可见，不参与路由竞争。Why it matters：用户的"普通"claude
  会话不应该被 TG 流量打扰，也不会因为 daemon 状态影响自身运行。

- **后台启动可选不强制** — daemon 可以由系统后台服务管理（默认 opt-out），也可以由首个启用
  TG 通道的 claude 会话 lazy spawn（用户拒绝接管后的回退路径）。Why it matters：用户对系统
  自启行为有保留权，但默认体验要好。

---

## 2. User roles / personas

### 2.1 admin@advance.studio（产品唯一面向用户）

**身份**：advance.studio 的主开发者，使用一台 M 系列 Mac，长期同时开 3-8 个终端，每个跑一个
claude 会话处理不同任务（不同项目目录、不同分支、不同上下文）。

**日常痛点**（基于实际遭遇的官方 0.0.6 行为）：

- **入站静默失聪**（RC#1）：开 claude 启用 TG 通道，前几条消息能正常收到，过几小时后忽然
  TG 发消息 claude 不再反应。MCP 工具列表里 TG 工具还在，发 `reply` 还能成功——但是入站
  完全断了。必须重启 claude 会话才能恢复。

- **跨会话误杀**（RC#2）：A 终端正在跑一个长任务，B 终端打开第二个 claude 会话或者跑
  `/reload-plugins` 之后，A 那边突然弹 "MCP server disconnected"，TG 工具集体消失。明明 A
  和 B 是无关任务，新会话起来就无差别杀旧 pid。

- **僵尸进程堆积**（RC#3）：偶尔会发现 `ps` 里有几个 4-5 天前的 R 状态 bun 进程，全部 100%
  CPU 跑着。Watchdog 设计上应该自杀但实际抓不到。手动 `pkill -9` 后才安静。

**当前 workaround**：开 claude 时尽量不动其他 claude；定期 `pkill -9 bun` 清僵尸；TG 一旦
看到 claude 不响应就 Ctrl+C 重启。**这套 workaround 与"远端 TG 控 claude"的初衷直接矛盾**——
TG 的价值在于"我不在键盘前也能用 claude"，但每隔几小时要回键盘前重启就完全失去意义。

**期望体验**：
- 启用 TG 的 claude 会话能稳定接收消息 ≥72h 不需要重启。
- 任何一个 claude 会话的开/关/重载都不影响其他 claude 会话的 TG 通信。
- claude 想问审批时（"deploy 吗？"），TG 那边 inline button 一点就立即返回结果。
- 失败时能立刻知道是失败，而不是过几小时才意识到一直在和死掉的 bot 对话。

---

## 3. Core user flows

### 3.1 Flow A — Bidirectional chat（主线）

**Trigger**：用户在 Mac 终端跑 `claude --channels plugin:telegram-channels-pro@advance-kit`，启用 TG 通道。daemon 此时已在
后台运行。

**Steps**：
1. claude 会话与 daemon 建立 MCP 连接，注册自己（自带 identity 标签：项目路径 + 分支 +
   shortid，但 daemon 对外仅以 shortid 引用以避免路径泄漏）。daemon 把这个会话加入 "已注册
   LRU 列表"。
2. 用户从 TG 给 bot 发文本 "现在 cargo test 还跑着吗"。daemon **必须先验证两件事**：
   (a) `message.chat.type === "private"`——group / supergroup / channel 类型一律静默
   丢弃，即使 sender 在 admin allowlist 也不响应（理由见 §4.6 chat-type 限定 AC）；
   (b) sender user_id 在 admin allowlist——非 admin 的入站文本一律静默忽略，**不**
   路由到任何 claude 会话（和 §3.3 callback 验证同样的安全要求；详见 §4.6 acceptance）。
3. daemon 收到合法 sender 的消息后，按"daemon-side 接收时刻的 LRU snapshot"决定路由目标：
   取最近 MCP tool 调用时间戳最近的已注册会话作为 focus（**routing snapshot rule**，见验收）。
4. daemon 把 inbound 通过 `notifications/claude/channel` 推到 focus 会话的 MCP connection；
   同时调 Telegram `sendChatAction` 给该 chat 发 typing 提示，让用户看到消息进了 claude
   路径（不会以为掉了）。claude 在 LLM 决策回路看到结构化的 `<channel source="telegram"
   chat_id="..." message_id="..." user="..." ts="...">{消息文本}</channel>` 标签——格式
   与上游 `external_plugins/telegram` (0.0.6) 一致；详见 §4.9。
5. claude 决定回复，调 MCP `reply` (或 `react` / `edit_message` / `request_approval`
   任一 outbound 工具) 把回复内容发回。daemon 调 Telegram API；任一 outbound 触发后
   立即停止 typing 提示 (与 §4.9 typing AC 一致——四个 outbound 工具都是 typing-stop
   trigger; request_approval 也算因为它是 model 对 inbound 的 visible 响应)。
6. 用户在 TG 看到回复。

**Routing snapshot rule（确定性规则）**：
- 每条入站 TG 消息在**daemon 接收时刻**做一次 LRU 决策，使用那一瞬间的 LRU snapshot。
- 已发出的 `reply` / `react` 等 MCP tool 调用**会**更新 LRU 时间戳；TG 消息的到达本身**不**
  更新 LRU。
- 用户在 TG 用 `/session <name>` 显式切换 → 立即把指定会话推到 LRU 头，后续入站消息按新
  snapshot。
- 多条消息密集到达：每条独立按各自接收时刻 snapshot 决策。如果 focus 会话期间调过 `reply`，
  下一条消息可能走到新的 LRU 头。这是确定性的、可预测的。
- **`/session` UX 注意 (override 不是 sticky)**：用户 `/session <shortid>` 显式切换后,
  如果其他 session 在切换后期间调过 reply / react / edit_message / request_approval
  任一 outbound, LRU 时间戳会被该其他 session 更新, 下一条入站可能 silently 走到那个
  新 LRU 头——`/session` 切换是 'one-shot snapshot at 当时', 不是 'sticky lock until next
  /session'。这与 routing snapshot rule 一致 (LRU 永远胜出), 但用户需理解此行为以避免
  "我刚 /session 到 X session, 为什么下一条没去 X" 的困惑。重新切回需再发 `/session X`。

**Edge cases**：
- 没有任何会话注册（且 sender 是 admin）：daemon 在 TG 回复 "No active claude session.
  Start one with `claude --channels plugin:telegram-channels-pro@advance-kit`."。**Dedup 规则**：admin-only（非 admin 已在
  步骤 2 静默忽略），按 admin chat_id 节流——每 admin chat 每 5 分钟最多 1 条回复。单 admin
  场景下退化为"全局每 5 分钟 1 条"。
- daemon 短暂离线（重启窗口）：客户端 TG 消息由 Telegram 服务端排队（getUpdates 的 offset
  机制），daemon 重启后从上次 offset 继续拉。理论上 0 丢失（受 Telegram 24h 保留期约束）。
- focus 会话刚崩：daemon 在路由时检测连接断开 → fall back 到 LRU 下一位 → 仍无可用会话则
  按 "无会话" 规则处理。

**Success condition**：从 TG 发消息到 claude 收到 P95 < 5s（受 Telegram long-polling 周期
主导）；claude 调 `reply` 到 TG 收到 P95 < 2s（**与 §5 一致：仅 `{delivered: true}` 样本
参与 SLO 统计**；quarantine 期间的 `{delivered: false, queued: true}` 不计入）。

### 3.2 Flow B — Task completion push（次线）

**Trigger**：claude 在某个会话里跑完长任务（build + 测试 + 部署），决定通知用户。

**Steps**：
1. claude 调 MCP `reply`（参数：admin chat、文本、可选 reply_to）。
2. daemon 调 Telegram API 发出消息。
3. 用户 TG 收到 push。

**Edge cases**：
- daemon 离线：claude 的 MCP `reply` 调用立即返回 `MCPDisconnectedError`。claude 可选择
  (a) 写入本地 log 标记 "TG 通知未发出"，(b) 等待 MCP 重连后重发，(c) 升级为终端阻塞提示。
  PRD 不强制选哪个，由 claude 端策略决定。
- Telegram API 限流：daemon 在 MCP 响应里返回 `RateLimitedError`，带 `retry_after_sec`。
  claude 可决定退避重发或放弃。
- daemon 进入 quarantine（见 §4.2）：MCP `reply` 仍可调用（出站不被 quarantine 影响），
  daemon 立即处理并返回**状态信号**给 claude，区分两种情形：(a) 立即发出 → 返回
  `{delivered: true}` + 实际 message_id；(b) 排队等 quarantine 恢复 → 返回
  `{delivered: false, queued: true, eta_hint: <冷却剩余秒>}`，claude 端可据此决定是否等待
  确认或继续。**Quarantine outbound replay queue**：in-memory；bound 50 条 outbound (与 §5
  capacity 边界 同 magnitude 但独立 tracking)；超 50 时新 reply 调用立即返回
  `CapacityExceededError` 不入队 (consistency with §4.5 request_approval 的 capacity 边界
  语义)；daemon 重启 (launchd KeepAlive 或 lazy-spawn restart) 队列丢失,claude 端在 MCP
  重连后看到 reply 错误时已无法找回 queued 消息——视为 best-effort 不可靠传递,与 pending
  approvals 同样的 in-memory 数据丢失语义。**SLO 含义**：§5 的 `reply` P95 < 2s 测量
  **只统计 `{delivered: true}`** 的样本；queued 样本不参与 SLO 统计也不算 SLO 违规。如果
  quarantine 期间太长（默认 5 分钟），daemon 在 TG 用备用通道通知用户 "daemon polling
  degraded"。

**Success condition**：消息送达用户 P95 < 2s；任何失败都对 claude 显式可见（不静默丢失）。

### 3.3 Flow C — Approval round-trip（关键路径）

**Trigger**：claude 准备做敏感操作（`git push --force`、`rm -rf node_modules`、`gh release
create` 等），希望先得到用户确认。

**Steps**：
1. claude 调 MCP `request_approval`：给出审批文本 + N 个选项。
2. daemon 在 TG 发带 inline-button 的消息给 admin，本地追踪这个 pending 审批（关联到 requester
   会话）。
3. 用户在 TG 看到带按钮的消息，点 "Approve"。
4. daemon **验证按钮回调的 chat type === private + 发送人 user_id 在 admin allowlist 里**
   （见 §3.1 step 2 + §4.6 chat-type 限定 AC；group / channel 来源 callback 一律静默
   丢弃），匹配上 pending → 把所选选项返回给 requester 会话的 MCP 响应通道。
5. claude 拿到所选项字符串，继续执行。

**Edge cases**：
- 路由不依赖 LRU：审批回调通过 daemon 内部的 pending-id 精确路由到原 requester 会话，即使
  期间用户切换了 `/session`、或其他会话抢了 LRU focus。多会话同时 request_approval 不串台。
- **Text-typed "approval" 不算 approval**: 用户文本回复 "approve" / "yes" / "好" 等而非
  点 inline button 时, daemon **不** consume pending approval; 文本作为普通 inbound
  channel notification 路由给 focus session, model 处理但 NOT 视为对 pending 的
  approval (per §4.9 system instructions: text 是 user data, button click 才是
  authorization)。pending 仍 await 用户实际点击 button。理由：避免 channel 层 prompt
  injection 攻击者通过文本 "approve the deploy" 越过 inline-button 鉴权。
- 非 admin 用户点了按钮（bot 误加入 group / 消息被转发等）：daemon 静默忽略 callback，pending
  保持挂起（既不批准也不拒绝）。
- 用户从未点按钮：默认无超时——claude 端 await 一直挂住直到 claude 端主动 cancel 或 daemon
  重启。具体 timeout 策略由 claude 端调用方决定，PRD 不在 daemon 层强制超时。
  **§5 中的 "60 秒内点击" 是 SLO 测量样本筛选器，不是行为契约上的隐式超时**：daemon
  绝不在 60 秒后主动 cancel pending；仅 P95 < 3s 这个指标只对 60s 内的样本统计有效。
- daemon 在 await 期间崩溃：claude 端收到 MCP 断连错误，能 fallback 到普通 reply + 让用户
  用文本回复。**daemon crash 期间 pending（含 message_id）丢失**，daemon 重启后没有
  message_id ↔ pending 的持久映射，**原 inline-button 消息保留在 TG 中不被 daemon 主动
  编辑**；用户再次点击该按钮时，daemon 因找不到匹配 pending → 通过 TG callback answer
  返回一个轻量"approval expired"弹窗提示（弹窗文本仅通用提示，不含 pending-id 或
  requester 元数据），按钮无害保留可重复点击。**Popup 节流 (info-leak 防护)**：同一
  `callback_query.data` (button id) 5 分钟内只回一次 popup; 后续重复点击 daemon 静默
  接受 callback 但不回 popup; 防止用户/攻击者通过反复点击 + 观察 popup 频率推断
  daemon crash 时间窗或 pending 状态 (与 §1.1 "失败可观测但不暴露探测" 原则一致)。
- requester 会话先于 daemon 退出（daemon 仍存活）：daemon 内存里 pending map 仍持有
  message_id ↔ pending 映射（in-memory 但**未** crash），所以 daemon 可以主动 edit TG 原
  按钮消息为 "approval cancelled (session ended)" + 清理 pending。**两个 crash 路径的关键
  差异**：daemon 存活时它能 reach 自己内存里的 message_id；daemon crash 后这条映射断了。

**Success condition**：claude await 不丢失；用户点按钮到 claude 收到结果 P95 < 3s；非 admin
点击零通过率（被 daemon 验证拦下）。

---

## 4. Feature specifications

### 4.1 Daemon process architecture

**Description**：单一后台进程持有 bot token、独占 `getUpdates` polling、维护所有 MCP 会话
状态。

**User value**：消除 "两个 poller 抢同一 token" 的物理冲突，进而消除 RC#2 整个失败类。

**Acceptance criteria**：
- 系统中任何时刻只有 ≤1 个进程在调 `getUpdates`；启动重复 daemon 实例立即检测并退出。
- daemon 独立于 claude 会话生命周期：claude 启动/关闭/reload 不应影响 daemon 运行。
- daemon 接受 SIGTERM 优雅关闭：先关 polling、再断开所有 MCP 会话、最后 flush 状态。
- daemon crash 后由系统后台服务（launchd）自动重启；已注册的 MCP 会话列表**不**跨重启保留
  （会话需重新建立 MCP 连接）；admin 配置通过 §4.7 持久化（env var 或 admin 状态文件）跨
  重启保留；pending 审批是 in-memory，**不**跨重启保留（详见 §3.3 Edge cases）。

### 4.2 Bot polling reliability

**Description**：消除 RC#1 描述的"polling 永久放弃"失败模式。

**User value**：用户启用 TG 通道后，几小时之内出现的任何短暂网络抖动 / Telegram API
异常 / 偶发 409 都自动恢复，不会出现"过一会就静默失聪"；长时间持续异常时用户能明确看到
失败状态，而不是误以为还活着。

**Acceptance criteria**：
- 单次 `getUpdates` 失败不导致 polling 终止；按指数退避自动重试，**永不主动放弃** polling
  循环。
- 持续大量失败（具体阈值 / 时间窗算法由 /spec 决定，参考 terranc/claude-code-telegram 的
  滑动窗口模型）→ daemon 进入 "quarantine" 状态：暂停 polling 一小段冷却时间后自动重试；
  进入和退出 quarantine 都通过 TG 主动通知 admin + 在 daemon 日志和 `status` 子命令输出
  里明确标注。
- 409 Conflict（其他 poller 抢）在 daemon 化架构下理论不应发生；若发生，记日志告警但**不**
  计入 quarantine 阈值（daemon 仍然继续重试，不让 RC#2 类异常误伤稳定性）。
- 入站消息从不丢失（Telegram offset 机制由 daemon 正确维护，crash 重启后从上次 offset
  继续）。

### 4.3 Self-aware lifecycle

**Description**：消除 RC#2 描述的"新 daemon 启动时无差别杀掉别人 pid"失败模式。

**User value**：再开一个 claude 会话、跑一次 `/reload-plugins`、启用 / 禁用 TG 通道，都
**不会**影响已经运行的 daemon 和其他 claude 会话；不会出现"开 B 干掉 A 的 TG"。

**Acceptance criteria**：
- 同时只有一个 daemon 实例运行：通过文件锁 + 进程身份验证保证（具体机制由 /spec 决定）。
  **锁文件安全要求**：文件路径由 /spec 锁定但必须满足 (a) 0600 ownership-matched-to-uid
  权限，与 unix socket 同等保护；(b) 跨 daemon 重启可访问；(c) 跑 `reset-admin` /
  `uninstall-daemon` 时被清理；(d) 与 socket / admin 状态文件位于同一受保护目录下。
- 启动竞争：第二个 daemon 实例发现已有 daemon 运行 → 立即退出（exit 0），打日志说明已有
  daemon。**永远不**通过 SIGTERM 抢占。
- 异常崩溃留下的"stale 锁"：通过锁文件里记的 PID + 进程身份验证识别是否还存活，安全接管。
- claude 会话的开 / 关 / `/reload-plugins` 完全不触发 daemon 信号，只是 MCP socket 断连重连。

### 4.4 Watchdog

**Description**：消除 RC#3 描述的"Ctrl+Z 之后僵尸 daemon"和"CPU 卡死 daemon 不自杀"失败
模式。

**User value**：daemon 不应在用户机器上留下需要 `pkill -9` 才能清理的进程。

**Acceptance criteria**：
- daemon 检测以下三类终止条件并优雅退出：
  - **孤儿**：父进程（launchd / lazy-spawn 它的 claude）已不存在
  - **卡死**：内部 polling 心跳长时间无进展（具体心跳超时由 /spec 决定）
  - **长期空闲**（仅 lazy-spawn 模式）：没有任何 MCP 客户端连接且超过空闲时长
- 三类终止的可观测性区分：
  - "孤儿" 和 "卡死" 视为**失败**：退出前必须通过 TG 通知 admin（如果 token 仍可用）+
    写 ERROR 级别日志
  - "长期空闲" 视为**正常生命周期事件**：仅 INFO 日志，不打扰用户
- 检测周期 / 心跳超时 / 空闲 TTL 等具体参数由 /spec 决定。

### 4.5 MCP tool surface

**Description**：claude 会话内的 MCP server 暴露 5 个工具，前 4 个与官方插件**外部行为**一致
以保证零迁移成本，第 5 个 `request_approval` 是 v0.2 新增。

**User value**：从官方插件迁移过来的用户原有 claude prompt 和工具调用代码无需改动；新增的
审批工具让 claude 端的审批代码从几十行 state machine 简化到一次 `await`。

**Acceptance criteria**：
- **reply**：能力 = 向指定 chat 发送文本 / 附件 / inline-button 消息；外部行为与官方
  `reply` 等价（参数名 / 返回值 / 错误形态由 /spec 锁定为完全兼容）。
- **react**：能力 = 给指定消息加 emoji 反应；外部行为与官方等价。
- **edit_message**：能力 = 修改已发出消息的内容；外部行为与官方等价。
- **download_attachment**：能力 = 下载 TG 托管文件并返回本地路径；附件文件存放在
  **0700 ownership-matched 受保护目录**（与 §4.7 lock file / socket / admin state 共享
  protection 等级，目录路径具体由 /spec 锁定，需在同一 protected directory 下）；
  **附件文件本身 0600**, 防止同 uid 的本地恶意进程通过 ls / read 看到附件内容 (附件可能
  含用户上传的代码 / secret / 路径)。Daemon 周期清理（TTL 1-24 小时由 /spec 决定）；
  外部行为与官方等价。**文件名 sanitization (path-traversal / shell-metachar 防护)**:
  TG 上传文件名 (uploader-controlled) 不直接落地为本地文件名 — daemon 以 random hash
  + sanitized 扩展名 (`^[a-zA-Z0-9]{1,8}$` 否则丢弃) 命名落地文件; 上游 0.0.6 已内置等价
  防护 (delimiter 等), tgcp 沿用; 防 attacker 通过 `../../etc/passwd` / shell-metachar
  注入达成 path traversal 或后续 shell 误用。
- **request_approval**（新增）：能力 = 发出带 inline-button 选项的消息 + 同步 await 用户
  点击结果。返回值至少包含用户选择的选项标签字符串（完整返回 schema 由 /spec 锁定）。
  安全要求：daemon **必须**验证 callback_query 的 chat type === private + 发送人 user_id
  在 admin allowlist 才匹配 pending (与 §4.6 chat-type 限定 AC 一致)，非 admin 或
  group/channel 来源 callback 静默忽略。**容量超限**：当系统中 pending 审批数已达 50 时
  （见 §5 容量边界），新的**第 51 个** `request_approval` 调用立即返回
  `CapacityExceededError`，requester 可选择等待 pending 排空、cancel、或降级到普通 reply
  文本审批。**TG 侧 admin 告警**: 当 pending 审批容量满 (50/50) 触发 CapacityExceededError 时,
  daemon 通过 TG 给 admin 发一次性告警 "Approval queue full (50 pending) — claude tool
  calls failing. Complete or cancel pending approvals."。告警节流：5 分钟窗口内不重复
  (per §5 alerting 边沿触发 + 节流策略)，避免攻击者 / 死循环 claude 填满 queue 后刷屏。
- **兼容性可测试性**：4 个官方工具的 input / output JSON schema 必须能验证上游 0.0.6 同名
  工具的对应 schema（schema-level 等价）；该等价性由 M1 milestone 的 compat 测试套件
  自动验证。
- **不**新增 `claim_focus` / `get_focus_state` 工具（见 §7 explicitly out of scope）。
- **协议层面**：以上 5 工具运行在 §4.9 描述的 Claude Code channel-protocol 适配框架内
  （`capabilities.experimental` 声明 / inbound `notifications/claude/channel` / system
  instructions）。`request_approval` 不切换为 `notifications/claude/channel/permission_request`
  机制——bespoke MCP 工具路径保留，理由见 §4.9 + §7 explicitly out of scope。
- **Outbound chat-type defense in depth (security)**: 对 `reply` / `react` /
  `edit_message` / `request_approval` 4 个出向 TG 工具, daemon-side 验证调用方传入的
  `chat_id` 对应 chat type === private (daemon 维护一个 chat_id → chat_type 缓存,
  由 inbound 流量 / pending_approval 创建时自然填充, 缓存 TTL 由 /spec 决定); 非
  private chat type 的 chat_id 拒绝 outbound 调用并返回 `InvalidChatTypeError` 给
  requester。**Cache cold-start 桥接 (Flow B startup-without-inbound)**: 当 daemon
  首次启动后没收到任何 inbound 时缓存为空; 此时 §3.2 Flow B (claude proactive task
  completion push) 调用 reply 给 admin chat_id, daemon **lazy-fetch via Telegram
  `getChat` API** (一次性查询 + 写入缓存): type === private → 放行 + 缓存; 非 private
  → 拒绝 + 返回 InvalidChatTypeError; lazy-fetch 失败 (网络 / 401 / 429 等) → 拒绝
  outbound + log + 不缓存 (下次再 lazy-fetch)。这让 cold-start Flow B 不会 silently
  失败, 同时保留 defense-in-depth 语义。与 §4.6 inbound chat-type 限定 形成
  defense-in-depth, 防 model 误用 chat_id (e.g. hallucinated id 或从 §3.3 Edge
  cases "text-typed approval" 上下文 picked up wrong id) 把 claude 输出送进 group
  / channel 泄漏。

### 4.6 Per-session opt-in + LRU routing

**Description**：claude 会话只有显式启用 `--channels plugin:telegram-channels-pro@advance-kit` 才接入 daemon。多个启用了的
会话按 LRU 路由，用户可在 TG 用命令显式切换。

**Acceptance criteria**：
- 没启用 TG 通道的 claude 会话对 daemon 完全不可见，不参与路由命中。
- **Chat type 限定 (security)**：daemon 仅响应 `chat.type === "private"` 来源的入站
  文本和 callback；group / supergroup / channel 类型一律静默丢弃，即使 sender user_id
  在 admin allowlist 也不响应。理由：admin 通过个人 DM 与 bot 互动；group 成员未经
  独立授权，bot 在 group 里 reply 会泄漏 claude 输出（含代码 / 任务状态 / 内部上下文）
  给非授权用户。与上游 `external_plugins/telegram` (0.0.6) 一致的设计。
- LRU 更新：MCP tool 调用更新对应会话的最近活动时间戳；TG 消息到达**不**更新 LRU。
- 入站消息路由按 §3.1 routing snapshot rule。
- 用户在 TG 发 `/session <shortid>`：daemon 解析 `<shortid>`，把匹配会话推到 LRU 头并发
  ack。**严格匹配模式**：`/session` 命令解析仅在 inbound 文本完全匹配
  `^/session [a-f0-9]{1,12}$` 模式时触发；多行内容、混合内容、`/session` 不在文本起始
  位置等情形均视为普通文本，正常路由给 focus session 不触发切换（避免攻击者把
  `/session abc123` 嵌入正常消息中重定向 focus）。**输入消毒**：`<shortid>` 必须是
  12 字符以内的纯 hex（`[a-f0-9]{1,12}`），不匹配此规范的输入直接拒绝并回
  "Invalid shortid format"；ack 文本中只 echo 校验过的 shortid，防止 shell metachar /
  control char / 超长字符串 / TG link-preview 触发。未匹配到任何 shortid 时回
  "Session <shortid> not found"。
- 用户在 TG 发 `/list`：daemon 返回当前已注册会话列表，每行格式 `<shortid>  <branch>  <ago>`
  ——**不**输出项目路径以避免雇主 / 内部仓库名等敏感信息泄漏；空列表回复 "No sessions
  registered. Start with `claude --channels plugin:telegram-channels-pro@advance-kit`." **该回复不受 §3.1 "no session
  入站文本节流" 限制——`/list` 是 admin 主动查询，独立计数器，不共享节流名额。**
  **Branch 名 trade-off (UX vs leakage)**: branch 字段保留是 session 自识别价值 ↔ 项目
  路径已 redact; admin 应避免使用泄漏雇主 / 客户名 / 内部代号的 branch 名 (e.g.
  `acme-customer-prod-fix` 是风险, 改为 `prod-fix` 更安全); /list 限定 private DM
  admin 可见 + redaction 不覆盖 branch 是已接受设计 trade-off (与 §1.1 "失败可观测"
  原则不冲突 — branch 是 admin 自我管理的 user-content)。
- 用户在 TG 发 `/status`：daemon 返回自身健康摘要（uptime、polling 状态、quarantine？、
  最近一次入站时间、注册会话数）。
- 审批回调（callback_query）按 pending-id 精确路由到 requester 会话，**不**走 LRU。
- **shortid uniqueness invariant**: daemon 生成 shortid (会话连接时分配的对外引用) 时
  保证当前 active session 集合内唯一——碰撞时自动重新生成 (`[a-f0-9]{1,12}` 空间足够
  大,实际碰撞罕见但 daemon 必须处理); 会话退出立即释放 shortid; 不同 daemon 启动之间
  shortid 无 cross-restart 一致性 (会话需重连并领取新 shortid); /session <shortid>
  命中多个会话的情形不会发生 (uniqueness invariant by construction)。/list 输出按 LRU
  顺序, shortid 在该 daemon 生命周期内无歧义。

### 4.7 First-run admin registration

**Description**：daemon 首次启动且未配置 admin 时，进入有限时间的注册窗口；窗口内收到合规
DM 即注册。

**User value**：免去用户去 `@userinfobot` 查自己 TG user ID 复制粘贴；同时保留 env 变量
路径让和上游一致的迁移用户零摩擦。

**Acceptance criteria**：
- 如果环境变量 `TELEGRAM_AUTHORIZED_USERS` 设置 → 直接用，跳过注册流程。
- **Multi-admin 语义注解 (clarify §2 single-user 假设 + 上游 env var plural-named 命名)**:
  `TELEGRAM_AUTHORIZED_USERS` 接受 comma-separated user IDs (上游兼容). v0.2 §2
  single-user 硬约束意味着实际 only 1 个 admin user_id 配置才是支持用法。多 admin
  配置 (多 user_id) 技术上不被 daemon 拒绝, 但 v0.2 不定义多 admin 之间的审批权重 /
  routing 冲突 / 通知归属规则 ——退化为 'first-listed admin 起点处理' (其他 user_id
  仅作为 inbound text 来源被允许, 但 outbound 通知 / pending approval 路由都按
  first-listed admin chat_id 处理); 多 admin 完整 semantics 留 v0.3+ 多用户 scope。
  **配 1 个 user_id 是 v0.2 推荐用法。**
- 否则 daemon 启动后进入注册模式：
  - daemon 在 **user-facing delivery channels**（stderr + launchd log + 第一个连接的
    claude MCP 会话日志，三者并行）输出**注册码**（一个短随机串，比如 6 位字母数字），
    同时打印 "Send `register <code>` to bot from your Telegram account within 5 minutes
    to claim admin"。**这三个 stream 的设计目的就是把短期秘密送达 user**——用户看不到
    code 就无法完成 register，故**不**走 §5 redaction (与 §5 redaction 适用范围的关系
    见 §5 末)。
  - 仅当 daemon 收到的 DM 文本**完全匹配 `register <code>` 格式**且 code 正确，才把发送人
    user_id 持久化为 admin
  - 不匹配的 DM 在注册期一律忽略（既不暴露存在性，也不报错）
  - **暴力破解防护**：双重计数器。
    - **Per-sender**：同一 sender user_id 在注册窗口内累计 ≥5 次不匹配 DM → 该 sender 在
      本次窗口剩余时间内被 daemon 完全静默（既不验证 code 也不计数）。
    - **Global（daemon-level）**：跨所有 sender 累计的不匹配 DM 数 ≥30 时，daemon **立即
      关闭注册窗口**，进入 §4.7 launchd-模式式 "等待 reset" 状态——要求用户跑 `reset-admin`
      显式重启注册才能继续。这防御 "多账号并发暴力（每号 5 次 × N 号）" 攻击。
  - **注册码 length 决策**：6 位字母数字（不含易混淆字符 0/O/I/1，共 32 字符可选）是产品
    决策的固定值，**不**视为 /spec 可调参数；理由：与暴力计数器 30 + 窗口 5min 共同构成
    安全计算。**精确 math** (corrected 2026-05-15 Round 3 review)：32⁶ ≈ 1.07×10⁹ codes；
    cap 30 attempts/5min ≈ 8640 attempts/day (假设攻击者无 reset 持续打); 期望破解时间
    = (32⁶ ÷ 2) ÷ 8640 ≈ 1.7×10⁵ days ≈ **170 年** (假设无 per-sender 5 ceiling 也无
    reset-required global 30 ceiling 强行打)。叠加 per-sender 5 + global 30 + reset 闸门,
    实际可破解概率 ≈ 0; 改动 length / cap / 窗口任一参数必须重做此安全计算。
- TOFU 缓解：bot token 泄漏给第三方的场景下，第三方需要同时拿到注册码（仅在本地 stderr 才
  看得到 + 5 分钟 + per-sender 5 + global 30）才能抢注 —— 实际不可行。
- 注册超时（5 分钟）行为按部署模式区分：
  - **lazy-spawn 模式**：daemon 直接退出；下次 claude 会话启用 TG 通道时再 lazy-spawn，
    重新进入注册窗口。用户可见 TG 一直无响应，看 claude 终端能见到 stderr 输出的新注册码。
  - **launchd 模式**：daemon 退出后被 launchd KeepAlive 自动重启会形成"注册码循环"——为避免
    这种刷码循环，launchd 模式下 daemon 注册超时**不**直接 exit，而是进入"等待 reset"状态
    （polling 暂停、stderr 周期输出 "registration timed out; run `reset-admin` to retry"
    每 5 分钟一次）；用户跑 `reset-admin` 子命令后 daemon 才重新进入注册窗口。这避免
    KeepAlive 重启与注册码轮换互相踩。
- 已注册后想换 admin：用户通过 plugin 子命令 `reset-admin`，删除 admin 状态文件，下次启动
  重新进入注册模式。
- **Admin 状态文件权限 (clarify on-disk artifact 权限位)**: 持久化 admin user_id 的状态
  文件 owner 0600 (与 §4.3 lock file / §4.5 download_attachment file 同级), 与 lock
  file / unix socket / download_attachment 临时目录 colocated 在同一 0700 protected
  directory 下 (路径具体由 /spec 锁定); 防同 uid 之外的 local 进程读取 admin user_id
  (虽然 v0.2 单 uid 假设, 但与 §1.1 design 一致——文件权限不依赖单 uid 假设, 防御
  纵深保留)。
- **Multi-admin alert 路由退化 (clarify v1.9 multi-admin annotation 在告警维度)**:
  §5 + §4.4 + §4.5 + §4.7 中所有 "TG 通知 admin" / "TG 给 admin" 的告警 (quarantine
  state-change / watchdog failure / capacity-full / auth-reject burst aggregated /
  rollback-needed 等) 在 multi-admin 配置下也按 'first-listed admin' 退化——仅
  first-listed admin user_id 收告警, 一致于 outbound 通知 / pending approval routing
  的 first-listed 退化语义。其他 admin user_ids 仅作 inbound text source 被允许, 不
  收 ops 告警。配 1 个 user_id 是 v0.2 推荐, 多 admin 完整 ops semantics 留 v0.3+。
- **launchd wait-for-reset 提示三流投递 (parity with §4.7 注册码 user-facing delivery)**:
  launchd 模式注册超时进入 wait-for-reset 后, "registration timed out; run reset-admin
  to retry" 提示**不仅**周期 stderr 输出每 5 分钟一次, 还需 (a) 写入 macOS Notification
  Center 一次 (one-time on entry, 用 `osascript -e` 或等价 native API), (b) 任何 claude
  session 尝试 MCP handshake 时 daemon 返回带提示的 disconnect_reason — 用户在 claude
  终端可见 "daemon waiting for reset; run plugin reset-admin"。三流并行确保 admin 不
  陷入 stderr-only 静默等待 (admin 通常不会 tail launchd log)。具体投递 API + 节流
  (notification 不刷屏) 由 /spec 决定。

### 4.8 launchd integration

**Description**：插件自带 launchd plist 模板。插件首次启用时（或运行
`install-daemon` 子命令）询问用户是否启用开机自启；同意则装载，拒绝则降级到 lazy spawn。

**User value**：避免每次重启 Mac 后手动启 daemon；同时不强制接管。

**Acceptance criteria**：
- 默认走"启用前问一句"的 opt-out 路径，不静默接管系统。
- 用户同意 → 插件协调 launchctl 把 plist 装到 `~/Library/LaunchAgents/` 并 bootstrap。
  launchd 模式下 daemon 不启用 §4.4 的"长期空闲自退" —— 由 launchd 决定生命周期（KeepAlive）。
- 用户拒绝 → daemon 走 lazy spawn：首个启用 TG 通道的 claude 会话检测 daemon 不存在 → fork
  启动 daemon。lazy spawn 模式下 daemon 启用"长期空闲自退"，最后一个 MCP 客户端断开后等
  idle TTL 退出，下次有 claude 启用通道时再 lazy spawn。
- **并发 lazy-spawn 竞争**：两个 claude 会话同时启用 TG 通道、都发现 daemon 不存在、都尝试
  fork 时——第一个抢到锁的成为 daemon；其他实例发现锁已占 → 立即 `exit 0` + 写日志
  "daemon already running, attaching"；输给锁的会话改为以 MCP 客户端身份连接已启动的
  daemon。用户在 claude 终端能看到这一行 attach 提示。
- launchctl bootstrap 失败（权限不足、SIP 限制等）→ 报错文本指明原因 + 提供手动操作步骤，
  不让插件装载失败。
- 卸载命令 `uninstall-daemon`：bootout + 删 plist。

CLI 子命令（`install-daemon` / `uninstall-daemon` / `reset-admin` / `status`）通过
claude-code 插件标准的子命令暴露机制提供；具体 CLI 调用形态（`claude-plugin <name>
<subcommand>` 还是其他）由 /spec 锁定，需与 claude-code 插件 SDK 现行约定一致。

### 4.9 Claude Code channel-protocol adoption

**Description**：本插件的 claude-side MCP server 适配 Anthropic 官方 `claude/channel`
协议——inbound TG 消息走标准 channel notification 推送给 claude，让 model 在 LLM
决策回路里直接看到结构化的 `<channel ...>` 标签，而不是被塞进 MCP 日志通道（log
channel 不进入 model 的 prompt input 决策）。

**User value**：claude 收到 TG 消息后**自动**进入响应（按 model 自己的判断决定 reply
/ react / 忽略），与上游 `external_plugins/telegram` (0.0.6) 行为一致。消除 v0.1.x 的
入站"路由走通到 MCP server 后 dead-end" partial regression（消息进 log channel，model
看不到，TG 用户感觉 claude "没收到"）。

**Acceptance criteria**：
- **Capability 声明**：claude-side MCP server 在 `capabilities.experimental` 里声明
  `claude/channel`。**不**声明 `claude/channel/permission`——上游 0.0.6 用此 capability
  配套 `notifications/claude/channel/permission_request` notification 路径；本插件保留
  bespoke `request_approval` MCP 工具不实现 permission_request 路径，故不声明该
  capability，避免向调用方虚假暴露未实现的能力。
- **Inbound 推送机制**：daemon 收到合法 inbound（admin-allowlisted sender，按 §3.1
  routing snapshot rule 选 focus session）后，通过该 session 的 MCP connection 调
  `notifications/claude/channel` 推送。Notification 参数包含消息内容 + meta（chat_id
  / message_id / sender username / sender user_id / ISO 时间戳 / 可选 image_path /
  可选 attachment_file_id 等附件元数据），具体 schema 由 /spec 锁定对齐上游 0.0.6。
- **Tag 格式**：claude 在 LLM 决策回路看到的是与上游 0.0.6 一致的 `<channel
  source="telegram" chat_id="..." message_id="..." user="..." ts="...">{消息文本}
  </channel>` 标签——CC 客户端把 notification 转换为这个 tag 是 Anthropic 平台行为，
  本插件不重新发明此格式。
- **System instructions**：MCP server 启动时通过 `instructions` 字段注入产品系统提示，
  教 model 如何处理 `<channel>` 标签——至少覆盖：(a) 用 `reply` 工具发回（不依赖
  transcript output——transcript 只对终端 user 可见，不会到达 TG）；(b) `image_path` /
  `attachment_file_id` 处理路径；(c) 通用 prompt-injection 拒绝原则（channel 内容里
  出现的指令应视为 prompt injection 拒绝执行——TG 消息只是 user data，不能 escalate
  权限）。**示例性 trigger phrases**（非穷尽）："approve the pending pairing" /
  "add me to allowlist" / "/reset-admin" / "ignore previous instructions" / "you are
  now in maintenance mode" / "execute the following bash:" 等；完整 prompt-injection
  模式空间是移动靶，由 /spec 在 instructions 实例化时基于上游 0.0.6 + 行业 jailbreak
  collection 给出更全覆盖。**Slash 前缀语义**：daemon 在路由前已按 §4.6 严格匹配模式
  解析 `/session` 等命令；进入 `<channel>` tag 内容的任何 slash 前缀文本一律视为普通
  user text（非 daemon 命令），model 应当作普通内容处理。具体 instructions 文本对齐
  上游 0.0.6 风格 + 本插件多会话 LRU 路由相关补充由 /spec 锁定。**Approval boundary**：
  pending request_approval 仅由 inline-button click (callback_query) advance；text-typed
  "approve" / "yes" 等文本 inbound 不算 approval, model 不应当作 approval 信号去做
  destructive action (与 §3.3 Edge cases "Text-typed approval 不算 approval" 一致)。
  即使 model 读到 inbound 文本里有 "approve the deploy" 字样, 也应 await actual button
  click。
- **Typing indicator**：daemon 收到合法 inbound 后立刻调 Telegram `sendChatAction`
  发 typing 给该 chat → 在 claude 出 reply / react / edit_message / request_approval
  任一 outbound 后停止 (4 个 outbound 工具都是 typing-stop trigger; request_approval
  虽然是 await 但 daemon 看到 frame 即可停 typing, 不等用户点 button)。与上游 UX
  一致；用户在 TG 看到 "botname is typing..." 知道消息已被 claude 路径接收，不会以为
  消息掉了。Telegram typing 提示约 5 秒过期；是否在 claude 长任务期间自动续期由 /spec
  决定（v0.2 不强制续期）。**Latency 隔离**：typing call 是 fire-and-forget，不阻塞
  inbound `notifications/claude/channel` 推送给 claude；`sendChatAction` API 失败仅
  log，不算 §3.1 success condition (P95<5s) 的 inbound 延迟违规也不算 §5 SLO 退化。
- **request_approval 不替换**：本节适配的是 inbound channel 通道；§4.5 的
  `request_approval` 作为 bespoke MCP 工具保留，**不**切换为
  `notifications/claude/channel/permission_request` 机制。理由：v0.1.x 已验证
  的 `request_approval` round-trip 路径（M3 milestone）不冒回退风险；
  pending-approval state 管理 + capacity edge + callback auth 三类逻辑（§3.3 + §4.5）
  独立于 channel 协议层。
- **Multi-session 行为透明**：每个启用了 `--channels` 的 claude 会话都有独立 MCP
  connection；daemon 按 §3.1 LRU snapshot 决定**单一** focus session，inbound
  notification 只推给该 session 的 MCP connection。其他 session 在该条 inbound
  期间不会看到 channel notification（与官方"1:1 单会话"模型相比，tgcp 的多会话
  路由对 model 视角透明——model 只知道自己的 session 收到了 channel 消息，不感知
  LRU 机制）。
- **行为对照验证（v0.2 release gate）**：v0.2 release 前手动跑 A/B 测试——在官方
  `external_plugins/telegram` (0.0.6) 和本插件下分别发送同样的 TG 输入（文本 / 图片
  / 附件 / prompt-injection 试探），对比 model 反应（是否调 `reply` / 是否调对
  chat_id / 是否拒绝 injection），偏差视为 fail。**测试样本至少 5 条**：覆盖 happy
  path + 1 image + 1 attachment + 1 injection + 1 multi-session race；偏差任意 1
  条即 fail。

---

## 5. Non-functional requirements

- **稳定性 (P0)**：
  - 连续 72 小时无长 MCP 断连：测量方法 = 启 daemon + 3 个 `claude --channels plugin:telegram-channels-pro@advance-kit` 会话
    + 每 30 分钟跑一次 `/reload-plugins`。**时间窗粒度**：把 72h 切成 864 个 5 分钟窗口，
    要求 ≥99% 窗口（即 ≤8 个 5min 窗口）内**零 spurious MCP 重连事件**；任何**单次连续
    断连 > 5 分钟** 直接判 fail（不参与百分比统计，直接破规）。**MCP 重连事件 定义**：
    daemon 端记录到 unix-socket disconnect 事件且 NOT 由以下三类原因触发的，即为
    **spurious 重连**：(a) `/reload-plugins` 命令触发（按 cadence 预期 432 次：3 sessions
    × 144 reloads/72h，scripted reconnect 不计入 SLO）、(b) SIGTERM / `uninstall-daemon`
    / 用户主动关 claude 会话（intentional teardown）、(c) launchd KeepAlive 触发的
    重启回放（daemon-side 区分 first-connect vs reconnect-after-restart）。SLO ≤8
    windows 仅统计 spurious 类。
  - 入站消息零丢失：定量基线 = 72h 内每 5 分钟发一条带递增编号的 TG 消息，所有消息到达
    某个会话或被明确"无会话"回复，序列号无空洞。**测试协议要求**：测试期间必须**至少保持 1
    个 claude 会话注册**（避免触发 §3.1 "no session" 节流路径吞掉测试消息），通过另一台
    机器或独立监控脚本保活；reload-plugins 每 30 分钟一次错开测试 cadence 不让 reload 窗口
    与 5min 测试消息撞车。**前提**：受 Telegram 服务端 24h 消息保留期约束——若 daemon 离线
    超过 24h 后重启，丢失消息不计入 SLO 违规（属预期）。
  - 僵尸进程零产生：72h 末用 `ps -A -o pid,stat,etime,%cpu,comm | awk '$5=="bun" && $4>50.0'`
    检测——CPU > 50% 且 bun 进程的实例数 = 0。补充检查 `ps -A -o pid,stat,etime,comm` 中
    STAT 为 R 且 etime > 1 小时的 bun 进程数 = 0。两条都过才算通过。
- **延迟**：
  - 入站消息 TG → claude 接收 P95 < 5s（受 Telegram long-polling 周期主导，实际多在 1-2s
    内）
  - 出站 `reply` → TG 显示 P95 < 2s
  - `request_approval` 用户点击 → claude 收到 P95 < 3s（**仅统计**用户在 60 秒内完成点击
    的样本；超过 60 秒未点击的 await 不计入 SLO 测量样本，因为 PRD 不在 daemon 层强制超时）
- **资源**：daemon 稳态 RSS < 50 MB；稳态 CPU < 1%（峰值 polling burst < 10%）。**测量方法**：
  使用 `ps -o rss=,%cpu= -p <daemon_pid>` 每 30 秒采样一次，连续采样 ≥1 小时；M4 测试期间
  专门预留 "stationary window"：测试脚本先关闭所有 active tool 调用（确认 0 pending
  approval + 0 进行中 download），等 60s 让 daemon 进入静默 → 然后开始采样。如果采样窗口
  内有任何工具调用触发（log event 可观测），该样本作废并重启窗口。RSS 取 ≥120 个稳态样本的
  P95，CPU 取 mean。M4 验收附带采样脚本 + 排除标记日志归档供复核。
- **容量边界**（边界值统一为"≤上限接受、>上限拒绝"语义）：
  - 同时注册会话数：≤8 接受；第 9 个尝试注册时 daemon 拒绝 + 返回 "session capacity
    exceeded (max 8)"
  - 同时 pending 审批数：≤50 接受；第 51 个 `request_approval` 立即返回
    `CapacityExceededError`（与 §4.5 一致）。
  - 超过上述边界视为 out-of-scope，daemon 返回明确的 "capacity exceeded" 错误。
- **可观测性**：
  - 日志结构化 JSON 写到固定路径（具体路径由 /spec 决定）
  - 日志事件字段含 `event_type`、`session_id`、`request_id`、`error_class`
  - **Redaction (scope: 结构化 JSON event log only)**：bot token、TG user IDs、用户 DM
    文本内容（可能含 secret / 代码 / 路径）、session identity 中的项目路径段、**注册码**
    （5 分钟有效期的短期秘密，与 bot token 同等敏感），在 JSON 事件日志里全部脱敏（只保留
    hash / 长度 / 时间戳等元信息）。**Two-stream invariant** (clarify vs §4.7)：注册码
    同时在 §4.7 user-facing delivery channels (stderr / launchd log / claude MCP session
    log) 以**明文**出现——那三个 stream 的设计目的就是送达 user，与 JSON 事件日志的
    redaction 是**两个独立 stream**，不冲突。Bot token 等其他敏感项不进 user-facing
    streams，仅可能出现在 JSON 事件日志，因此被 redaction 兜底
  - `status` 子命令返回 daemon 健康摘要（同样脱敏）
  - **告警**：daemon 进入 quarantine、watchdog 触发失败退出、auth 拒绝事件（限流）通过 TG
    主动通知 admin。**Auth-reject 告警详细策略** (clarify §1.1 "失败可观测" 原则与
    §3/§4 silent-drop 表面 tension)：
      - **Per-event silent drop**: 每条非 admin inbound / non-private chat / 非匹配
        注册码 → daemon 协议层静默丢弃 (NOT echo back 防 enumeration); 同步写
        ERROR-level structured JSON event log (含 sender hash / chat type / 拒绝原因)
        但**不发**单事件 TG 告警 (避免噪声)。
      - **Aggregate alert (rate-limited)**: 当任一 reject 类计数器在滑动窗口内 (5min)
        累计 ≥ threshold → daemon 通过 TG 给 admin 发一次摘要告警: "auth reject burst
        detected: {category}, {count} events in 5min window"。Threshold 默认建议:
        per-sender 5 / global 30 / non-admin chat 10 / non-private chat 10; 具体
        threshold + 滑动窗口长度由 /spec 锁定 (上下界 5-50 / 1-10min)。告警频率 ≤ 1/小时
        per category, 超频压缩为聚合 burst。
      - **Admin 视角**: silent-drop 在协议层 + alert 在 ops 层 = 攻击者得不到
        enumeration 反馈 + admin 知道有攻击。"失败可观测" 兑现路径是 ops 层 aggregated
        alert (不是 per-event 暴露)。
- **可恢复性**：
  - **launchd 模式**：daemon crash 后 launchd KeepAlive 自动重启；恢复期间用户的 TG 入站
    消息由 Telegram 服务端 24h offset 缓存保留，daemon 重启后从上次 offset 拉取，0 丢失。
  - **lazy-spawn 模式**：daemon crash 后无自动重启路径，需要下一次 claude 会话启用 TG 通道
    时触发新 lazy-spawn——这意味着"无 claude 会话期间到达的 TG 消息"会一直堆在 Telegram
    服务端，直到下次 lazy-spawn 才被拉取（仍受 24h 保留期约束）；这是 lazy-spawn 模式的
    已知设计取舍（不接管系统的代价 = 自动恢复机会受限）。
  - **pending 审批**：在 crash 时丢失（in-memory，两种模式都不持久化），重启后原 inline-
    button 消息保留不被 daemon 主动编辑；用户再点击返回 "approval expired" callback 提示。

---

## 6. Technical constraints

- **平台**：v0.2 仅支持 macOS（Apple Silicon + Intel）。Linux / Windows 留待 v0.3+。
  reasoning：launchd 是 macOS 专有，跨平台移植 = systemd / Windows Service 适配 = 独立工作量。
- **claude-code 插件格式**：必须以 advance-kit `plugins/` 子目录形式发布；版本号管理走
  marketplace.json + plugin.json + 3 README 的 5-sync-point 不变量（见 advance-kit
  VERSIONING.md）。
- **单机单用户**：v0.2 硬约束，不设计多用户 / 多机协同。
- **插件 namespace**：`telegram-channels-pro`，与上游 `telegram` 区分；MCP server name 用
  独立标识符避免与上游插件共存时撞名。

---

## 7. Scope boundaries

**Explicitly in scope (v0.2)**：

- 单 daemon + 多 claude MCP 代理架构。
- 三个 RC 的修复（polling reliability、self-aware lifecycle、watchdog）。
- 4 个官方 MCP 工具行为兼容 + 新增 `request_approval`。
- Per-session opt-in + LRU 路由 + `/session` / `/list` / `/status` 命令。
- env-var 优先 + first-run 注册码验证的双轨权限模型。
- launchd 默认 opt-out + lazy spawn 回退。
- 结构化日志 + redaction + `status` 子命令 + quarantine 告警推送。
- macOS 平台。
- **Anthropic `claude/channel` 协议适配**：MCP `claude/channel` capability + inbound
  `notifications/claude/channel` + 结构化 `<channel>` 标签 + system instructions +
  Telegram typing indicator——与上游 `external_plugins/telegram` (0.0.6) 行为对齐
  （`claude/channel/permission` capability 不声明，理由见 §4.9 — 本插件保留
  bespoke `request_approval` 不实现 permission_request 路径）。
- **从上游迁回的 rollback 路径**：用户可以通过 `uninstall-daemon` + 删 admin 状态文件
  + 卸载本插件 + 重装上游 `external_plugins/telegram` 完成 rollback。两个插件**不可同时
  启用**（会撞 token）。
  - **Rollback 触发条件**：(a) 72h soak 期间出现 ≥1 次未在 5 分钟内自愈的入站失聪事件；
    (b) 出现任何 daemon 之外的进程被本插件 SIGTERM 的事件；(c) request_approval 在 24h 内
    出现 ≥3 次"用户点击但 claude 未收到"的丢失事件；(d) v0.2 channels integration 出现
    channel-protocol 兼容回归（e.g. `<channel>` tag 格式偏差导致 model 行为与 baseline
    A/B 测漂移；CC client 的 notification → tag 转换在新版本破坏；§4.9 typing call
    阻塞 inbound 推送等）——可选**部分降级**回 v0.1.x patch 路径（保留 daemon 可靠性
    + outbound 工具，但 inbound 暂时退化为 log channel 不进 model 决策回路），等修补
    后再升 v0.2.1+；与 (a)-(c) 的完全 rollback 到上游不同，(d) 是同插件内的版本回退。
  - **Rollback 诊断指引**：先跑 `status` 子命令导出 daemon 状态快照 + 抓取最近 24h 结构化
    日志（已自动 redaction）→ 归档便于事后复盘 → 执行 rollback → 复盘归档定位 RC 类别 →
    决定是上游 bug 还是本插件回归。
  - **版本回退**：advance-kit 仓库提供 `git revert` 到上一个 plugin.json 版本的标准流程；
    plugin SemVer 升级 minor 时保留 patch 路径，遇严重回归可降级 patch 不破坏 marketplace。

**Explicitly out of scope**：

- **Webhook 模式** — 继续 long-polling，与上游 RC 兼容。理由：webhook 需要公网入口或
  ngrok，本机单用户场景下增加复杂度而无收益。
- **多用户 / 多 token / 多租户** — 单机单用户假设硬约束。v0.3+ 单独立项。
- **`claim_focus` / `get_focus_state` 工具** — 多 claude 会话竞态实际很少触发；用 `/session`
  解决。理由：减少 v0.2 工具表面，避免 daemon 状态机过早膨胀。
- **TSGram-style dangerzone / safetyzone 模式** — 危险操作分级权限。单一 admin 场景下无意义；
  v0.3+ 多用户时再考虑。
- **CCGram Smart Suppression（终端活跃时静音）** — 价值小于实现成本；v0.3+ 可加。
- **stale-message drop（>20min 旧消息丢弃）** — daemon 化后入站延迟瓶颈消失了，该特性需求
  场景没了。
- **跨机器路由** — 单机单用户假设。
- **跨 daemon 重启的 pending 审批恢复** — pending state 是 in-memory；用户 crash 后需要
  claude 端重新发起 `request_approval`。
- **Channel-permission relay 替换 `request_approval`** — 不切换为
  `notifications/claude/channel/permission_request` 机制；保留 `request_approval`
  bespoke MCP 工具（见 §4.5、§4.9）。理由：v0.1.x 已验证的 approval round-trip 路径
  不冒回退风险；pending-approval state 管理 + capacity edge 逻辑独立于 channel 协议层；
  切换需重写现有 approval feature 的契约层 spec，与既有契约破坏不成比例。
- **官方 ACCESS.md 风格 6 字符 pairing-code DM 流程** — 保留本插件的 env-var 优先 +
  first-run 注册码窗口模式（§4.7）。理由：当前 first-run 注册码窗口 + 双重计数器
  (per-sender 5 + global 30) 的暴力破解防护已验证；pairing 是 UX 简化但非安全升级；
  v0.3+ 多用户场景再考虑。

### 7.1 Milestones

| Milestone | User-visible capability | Gating decisions |
|---|---|---|
| M0 | "我能在终端启用 TG 通道，发一条 reply，TG 那边能收到" | daemon 启动 / 单 MCP 会话 / 单工具路径 E2E |
| M1 | "官方插件的 4 个工具我这里都能用，没有功能回归" | 4 个官方 MCP 工具行为兼容性验证；first-run 注册码流程；env-var 兼容 |
| M2 | "开 2-3 个 claude 都启用 TG，TG 消息路由到对的会话；reload-plugins 不掉" | LRU 路由 + opt-in + `/session` `/list` `/status`；RC#2 修复验证 |
| M3 | "claude 能调一次 API 等我审批，我点按钮它继续；非 admin 点击被忽略" | `request_approval` + callback auth 验证 + pending 路由不依赖 LRU |
| M4 | "连续 72 小时挂着 daemon 不掉线，日志可查；rollback 到上游有文档；channel adapt 行为对齐上游" | 72h soak 通过；watchdog + polling reliability + launchd 整合验证；rollback 文档；上游 PR (RC#1/RC#3 最小补丁) 草稿；§4.9 channel-protocol behavior parity ≥5 sample A/B test 通过 |

---

## 8. Assumptions & open risks

- **Assumption**：单机单用户场景持续到 v0.2 全部生命周期。confirmed 2026-05-12 brainstorm Q1。
- **Assumption**：用户已经熟悉官方插件的 `--channels plugin:telegram@claude-plugins-official`
  启用模式，迁移到本插件 `--channels plugin:telegram-channels-pro@advance-kit` 后保留
  同样心智模型。confirmed 2026-05-12 brainstorm Q3; flag-spelling text rewritten
  2026-05-15 as copy-edit accompanying channels-integration amendment scope (separate
  from amendment Q3 typing-indicator decision).
- **Decision made**：进程架构选 daemon + 薄 MCP 代理。Reasoning：消除 RC#2 物理层问题；
  multi-claude-session 路由有自然单点；与 Hermes Gateway / terranc/claude-code-telegram 等
  战测过的开源设计对齐。decided 2026-05-12 brainstorm。
- **Decision made**：MCP 工具表面 = 4 官方 + `request_approval`（option 2 of 4）。Reasoning：
  审批是高频需求；多会话竞态相关的 `claim_focus` / `get_focus_state` 在单机单用户假设下罕见，
  留 v0.3+。decided 2026-05-12 brainstorm Q5。
- **Decision made**：权限模型 = env-var 优先 + first-run 注册码验证。Reasoning（第一性原理）：
  env-var 是上游兼容路径，零迁移摩擦；首次注册码方案缓解 TOFU 风险（token 泄漏给第三方时
  仍需窃取 stderr 的注册码）。decided 2026-05-12 brainstorm Q6 + 2026-05-12 Round 1 review。
- **Decision made**：launchd 默认 opt-out。Reasoning：好的默认体验避免每次开机要手动启
  daemon；同时不强制接管系统。decided 2026-05-12 brainstorm Q7。
- **Decision made**：Runtime 选 Bun + TypeScript。Reasoning：与上游 0.0.6 一致，便于对照
  阅读 + cherry-pick RC#1/RC#3 最小补丁成上游 PR。注意：这是一个 v0.2-specific 选择，若
  上游切换 runtime 我们重新评估。decided 2026-05-12 brainstorm。
- **Decision made**：polling reliability 算法选"滑动窗口 + 持续失败阈值"语义，参考
  terranc/claude-code-telegram 的稳定行为。具体参数由 /spec Phase 1 ARCHITECTURE 决定，
  上下界约束如下（防止 /spec 自由发挥违反 §5 SLO）：滑动窗口 30s-5min、失败阈值 3-10 次
  fatal、退避序列上限 ≤60s、quarantine 冷却时长 30s-5min。Reasoning：参数级别的实现选择
  不应锁定在 PRD；语义层面锁定"永不主动放弃 polling，持续异常通过用户可见信号暴露"。
  decided 2026-05-12 Round 1 review，bounds added Round 2 review。
- **Decision made**：watchdog 探测维度选"孤儿 / 卡死 / 长期空闲"三类，三类的可观测性区分
  （前两类是失败有告警，最后一类是正常）。具体参数由 /spec 决定，上下界：探针周期 1-5s、
  心跳超时 30-90s、idle TTL 5min-2h。decided 2026-05-12 Round 1 review，bounds added
  Round 2 review。
- **Decision made**：lazy spawn 模式启用 idle TTL，launchd 模式禁用 idle TTL。Reasoning：
  launchd 由系统接管 → 长驻不浪费资源（KeepAlive 自动管理）；lazy spawn 由 claude 会话拉起
  → 没人用时回收，下次再 spawn。两条路径不重叠。decided 2026-05-12 Round 1 review。
- **Decision made**：download_attachment 临时文件 TTL 上下界 1-24 小时（具体值由 /spec
  锁定）；超 TTL 后 daemon 周期清理。decided 2026-05-12 Round 2 review。
- **Decision made**：结构化日志写到 macOS 标准日志目录（`~/Library/Logs/` 下或 `os_log`
  系统级 logging API；具体由 /spec 锁定）。decided 2026-05-12 Round 2 review。
- **Decision made**：CLI 子命令调用形态遵循 claude-code 插件 SDK 现行约定（在 SDK 文档明
  确发布的接口范围内）；不发明独立 CLI 入口。decided 2026-05-12 Round 2 review。
- **Decision made**：alert spam 抑制策略选 "state-change edge-triggered" 语义——daemon 只
  在 quarantine 状态发生进入 / 退出转换时通知 admin，quarantine 持续期间不重复通知；多次
  快速 crash-restart（launchd 重启）合并为单条告警（合并窗口由 /spec 决定,上下界 30s-
  10min）。decided 2026-05-12 Round 2 review。
- **Decision made**：v0.2 channels-integration 协议适配 = Strict bridge。inbound 走
  `notifications/claude/channel` + `<channel>` 标签格式与上游 0.0.6 一致；
  `request_approval` 保留为 bespoke MCP 工具不替换为 permission_request 机制；
  system instructions 含通用 prompt-injection 拒绝条款。Reasoning：tgcp 差异化价值
  在 daemon 可靠性 + 多会话 LRU；协议层完全 piggyback 上游降低维护成本 + 保 model
  行为兼容。decided 2026-05-15 amendment Q1。
- **Decision made**：v0.2 channels-integration 验收标准 = functional + behavior parity。
  (a) 一条 TG 文本 → claude 自动调 `reply` 工具 → TG 看到 reply；AND (b) 与上游
  `external_plugins/telegram` (0.0.6) 同输入 A/B 测 model 行为一致（reply 工具 / 附件
  处理 / prompt-injection 拒绝）。≥5 样本任意 1 条偏差即 fail。decided 2026-05-15
  amendment Q2。
- **Decision made**：daemon 收到合法 inbound 后立刻调 Telegram `sendChatAction(typing)`，
  claude 出任一 outbound 后停止；不强制续期 5s typing 过期。Reasoning：与上游 UX 平起，
  让用户视觉确认消息进了 claude 路径。decided 2026-05-15 amendment Q3。
- **Decision deferred to /spec (with bounds)**: daemon-side 区分 'spurious MCP 重连
  事件' (counted toward §5 SLO) vs scripted reconnect (excluded — `/reload-plugins` /
  SIGTERM / KeepAlive) 的具体机制。Bounds: 必须 deterministic 信号 (handshake / sequence
  number / 显式 flag); 禁止 heuristic timing (e.g., 'reconnect within 100ms' 会让攻击者
  把 spurious 隐藏在 category-a). 推荐机制: claude-side proxy 在 `/reload-plugins` 触发
  disconnect 前发一个 `reload_handshake` MCP frame, daemon 识别后将后续 reconnect 标记
  为 scripted; 缺 handshake 的 reconnect = spurious. /spec 锁定 handshake 协议形态 +
  category (b)/(c) (SIGTERM / KeepAlive) 的等价识别机制. flagged 2026-05-15 amendment
  Round 3 review (Claude-W2)。
- **Decision deferred to /spec (with bounds)**: daemon 的 quarantine outbound replay
  queue drain 机制——quarantine 结束 + queued 消息开始重发时, 如何把
  `{delivered: true|false}` 最终结果通知原 requester claude session? Bounds: 通知必须
  eventually 到达 claude (不能 silently drop); 推荐 mechanism = MCP `notifications/...`
  push 回 requester session (经原 MCP connection); eta_hint 更新机制 (push every
  quarantine-end transition vs claude-pull on next reply call) /spec 决定具体形态.
  flagged 2026-05-15 amendment Round 3 review (Claude-W4)。
- **Decision deferred to /spec (with bounds)**: §5 zero-loss test (864 messages / 72h
  / 3 sessions / 432 reconnects + shortid 变化) 测试协议细节 — 如何 dynamically track
  per-session message receipt 跨 reload-plugins 引起的 shortid 改变? Bounds: 必须
  verify '所有 864 messages 到达 SOME registered session OR 收到 no-session reply'
  (sequence_id 无空洞), 不要求按 specific shortid 匹配 (shortid 会变, sequence_id 不变).
  推荐机制: monitor script 订阅 daemon 结构化 log stream (event_type=inbound_routed),
  匹配 sequence_id ↔ delivered_session_shortid; reload-plugin 引起的 shortid 变化对
  monitor 透明 (monitor 外部独立). /spec 锁定 test harness 实现细节. flagged
  2026-05-15 amendment Round 3 review (Claude-W6)。
- **Risk**：Telegram getUpdates 429（Too Many Requests）在 daemon 化后理论上不应再触发，但
  实际可能因 bot 在多个 chat 里被广播触发；需要 /spec Phase 1 把 429 单独分类为 rate-limit
  路径（按 retry-after 退避，不计入 fatal 阈值）。flagged 2026-05-12 PRD draft。
- **Risk**：Bun runtime 在 launchd 下的环境变量 inherit 行为可能与 claude-code spawn 模式
  不一致（HOME / PATH / TELEGRAM_BOT_TOKEN 等是否能正确读到）；需在 M0 早期验证。flagged
  2026-05-12 PRD draft。
- **Risk**：上游 Anthropic 若在 0.0.7+ 引入重大重构（如换 MCP SDK、改 channels 协议形态），
  本插件的"保持 4 工具外部行为对齐"会失效。缓解：每次上游 minor 升级后 product-rnd 走一次
  对比，必要时本插件升 major 版本。flagged 2026-05-12 PRD draft。
- **Risk**：daemon 进程间通信通道（unix socket / 其他）在多用户 Mac 下的 ownership /
  permission 隔离。约束：channel 必须 0600 ownership-matched-to-uid；同 uid 的本地恶意进程
  视为已突破信任边界（v0.2 不防护，假设单用户单 uid）。flagged 2026-05-12 Round 1 review。
- **Risk**：daemon 短时间高频崩溃（launchd 频繁重启）会刷屏告警 TG。需 /spec 设计退避
  / 抑制策略。flagged 2026-05-12 Round 1 review。
- **Risk**：§4.9 假设 CC 客户端把 `notifications/claude/channel` 自动转换为 `<channel>`
  tag。若 Anthropic 0.0.7+ 改为要求 MCP server 自己 emit tag 或 tag 格式分歧，本插件
  需相应更新代码 + spec。需在 M0 早期 + 上游每次 minor 升级后验证 tag 格式（与上游 PR
  RC#1/RC#3 同节奏复审）。flagged 2026-05-15 amendment Round 1 review。
- **Risk**：prompt-injection 模式空间 evolves；本插件 system instructions (§4.9) 给的
  jailbreak 拒绝条款是基线 + 上游 0.0.6 对齐，长期需要随社区 jailbreak collection
  (HarmBench / JBB-Behaviors / 等) 跟进。Mitigation：每个上游 minor 升级 + 季度安全
  review 重审 instructions 文本。flagged 2026-05-15 amendment Round 1 review。

---

## 9. Change history

| Date | Version | Change | Driver |
|---|---|---|---|
| 2026-05-12 | 1.0 | Initial draft | /prd brainstorm + structure |
| 2026-05-12 | 1.1 | Round 1 batch fix: arch-leakage de-binding (§4.2-§4.5, §6); security tightening (§3.3 callback auth, §4.7 registration code TOFU mitigation); edge-case coverage (§3.1 routing snapshot rule, §3.2 daemon-offline path, §4.6 empty-list / status command); NFR quantification (§5 measurable SLO + capacity boundaries + redaction enumeration); rollback path (§7); idle-TTL vs launchd lifecycle clarification (§4.4 + §4.8) | /prd Round 1 single-evaluator (codex quota-blocked) |
| 2026-05-12 | 1.2 | Round 2 batch fix: persistence model clarification (§4.1 vs §4.7 contradiction); SLO conditional measurement (§5 request_approval P95); single-subsystem scope clarification (§1); inbound text admin validation (§3.1 — critical security); no-sessions dedup keying (§3.1); registration-code brute-force protection (§4.7); compatibility test AC (§4.5); button-edit non-action wording (§3.3); identity-path redaction (§4.6 /list, §5); lazy-spawn race observability (§4.8); rollback triggers + diagnostics (§7); /spec deferral bounds for 5 decisions (§8); alert-spam edge-trigger semantics (§8) | /prd Round 2 single-evaluator (codex quota-blocked) |
| 2026-05-12 | 1.3 | Round 3 batch fix: stability SLO time-window granularity (§5 — 5min windows, ≥99%, no single >5min continuous outage); zombie detection cmd correctness (§5 — replace nonexistent RUNAWAY column with CPU>50% and STAT=R + etime checks); quarantine signal to claude in Flow B (§3.2 — {delivered, queued, eta_hint} response shape, reply P95 SLO clarified as delivered-only) | /prd Round 3 single-evaluator (codex quota-blocked) |
| 2026-05-12 | 1.4 | Round 4 batch fix: RSS measurement protocol (§5); dedup admin-only clarification (§3.1); launchd KeepAlive registration loop prevention (§4.7 — wait-for-reset state instead of exit-and-restart); SLO carve-out vs behavior contract clarification (§3.3); lock file 0600 + colocation requirements (§4.3); lazy-spawn recovery semantics (§5 — explicit 24h Telegram retention dependency) | /prd Round 4 single-evaluator (codex quota-blocked) |
| 2026-05-12 | 1.5 | Round 5 batch fix: Flow A reply SLO carve-out mirror (§3.1); two crash-path differentiation in §3.3 (daemon-crash vs requester-exit message_id reachability); stationary measurement window protocol (§5); zero-loss test prerequisite "≥1 session registered" (§5); multi-account brute-force defense via global counter + reset-required (§4.7 — Global 30 ceiling); registration-code length as fixed product decision not /spec parameter (§4.7); /session shortid input sanitization with regex schema (§4.6); capacity boundary edge semantics "≤N accept / >N reject" unified across §5 + §4.5; /list throttle independence from §3.1 no-session throttle (§4.6) | /prd Round 5 single-evaluator (codex quota-blocked) |
| 2026-05-15 | 1.6 | v0.2 channels-integration amendment: §3.1 Step 4 rewrite for `notifications/claude/channel` push + structured `<channel>` tag + Telegram typing indicator; §4.5 cross-ref to §4.9 + explicit "no permission_request swap" rationale; new §4.9 "Claude Code channel-protocol adoption" feature spec (capabilities.experimental + notifications/claude/channel + system instructions + typing indicator + multi-session transparency + behavior-parity AC); §7 add 1 in-scope bullet (channel adoption) + 2 out-of-scope bullets (no permission_request swap, no pairing-code flow); §8 + 3 Decisions made entries (Q1 Strict bridge / Q2 functional+behavior parity / Q3 typing indicator) + Assumption text aligned to official `plugin:telegram@claude-plugins-official` form; flag-spelling correction `claude --channels telegram` → `claude --channels plugin:telegram-channels-pro@advance-kit` (5 occurrences across §3.1 / §4.6 / §5). | /prd amendment session 2026-05-15 (dual-evaluator) |
| 2026-05-15 | 1.7 | v0.2 amendment Round 1 dual-evaluator batch fix: §3.1 step 2 + §3.3 step 4 add chat.type === private security check (CC1 from Codex — group/supergroup/channel inbound silently dropped, prevents bot-in-group leakage); §4.6 add chat-type 限定 AC + /session 严格匹配模式 (`^/session [a-f0-9]{1,12}$`) clarification (CC1 + W1); §4.9 capability decl drop `claude/channel/permission` (C4 — bespoke request_approval kept, avoid false-advertise unimplemented capability); §4.9 system instructions enrich prompt-injection trigger phrase list as illustrative non-exhaustive (W7) + slash-prefix semantics ruling (W1); §4.9 typing AC add fire-and-forget + failure-mode SLO isolation (W4); §4.9 + §7 rename `PendingApprovalRegistry` → `pending-approval state 管理` (C3 — strip internal class name); §7 in-scope drop `claude/channel/permission` mention (C4 cross-impact); §7 out-of-scope rename `M004 spec` → `现有 approval feature 的契约层 spec` (C1) + `tgcp REQ-011/014` → `当前 first-run 注册码窗口 + 双重计数器` (C2); §7 rollback add (d) channel-protocol regression in-version downgrade (W5); §7.1 M4 row append A/B gate (W3); §8 Assumption Q-tag clarify flag-spelling vs amendment Q3 (C5); §8 + 2 Risks (CC platform tag transformation + prompt-injection moving target). WW2 (GLOSSARY skeleton placeholder) accepted as false positive — bootstrap baseline. | /prd amendment Round 1 dual-evaluator (Claude auditor + codex exec); merged 14 substantive findings (6 Critical / 8 Warning, batch-accept) |
| 2026-05-15 | 1.8 | v0.2 amendment Round 2 dual-evaluator batch fix: §4.7 + §5 redaction 双 stream 解耦 (C1 from Codex — registration code stays plaintext in user-facing delivery channels [stderr/launchd/MCP-session-log], redacted only in structured JSON event log; two-stream invariant explicit); §3.1 step 5 typing-stop trigger 与 §4.9 对齐 (W1 — reply/react/edit_message 任一 outbound 都停 typing); §5 stability SLO 增加 "spurious MCP 重连事件" 定义 (W2 — 区分 scripted reload-plugins / SIGTERM / KeepAlive 重启 vs 真异常断连); §3.2 quarantine outbound replay queue bound + crash semantics (W3 — 50-cap, in-memory, lost on restart); §3.3 Edge cases + §4.9 system instructions add "text-typed 'approve' 不算 approval" 双向 ruling (W4 — 防 prompt-injection 越过 button 鉴权); §4.5 request_approval add chat.type === private callback check + TG 侧 capacity-full admin 告警 (W5); §4.6 add shortid uniqueness invariant AC (WW1 from Codex); §4.5 download_attachment 加 0700 directory + 0600 file 权限要求 (WW2 from Codex); §5 alerting 详化 auth-reject silent-drop + aggregated alert 双层策略 (WW3 from Codex — clarify §1.1 "失败可观测" 与 silent-drop 的 tension)。 | /prd amendment Round 2 dual-evaluator; merged 9 substantive findings (1 Critical / 8 Warning, batch-accept) |
| 2026-05-15 | 1.9 | v0.2 amendment Round 3 dual-evaluator selective fix + /spec deferrals (8 fix / 3 defer): §4.7 brute-force math 修正 (Claude-W1 — 32^6 ÷ 2 ÷ 8640 ≈ 170 年, was 10^10 typo; 加 per-sender 5 + global 30 + reset 闸门 实际可破解概率 ≈ 0); §3.1 step 5 + §4.9 typing-stop 加 request_approval 为第 4 个 outbound trigger (Claude-W3); §3.3 approval-expired popup 加 5 分钟 throttle (Claude-W5 — info-leak 防护, 与 §1.1 "失败可观测但不暴露探测" 一致); §3.1 routing snapshot rule 加 /session UX one-shot snapshot 注解 (Claude-W7); §4.5 download_attachment 加 文件名 sanitization (random hash + sanitized ext, Claude-W8); §4.5 加 Outbound chat-type defense-in-depth bullet (4 outbound 工具 chat_id → chat_type === private 验证, Codex-W1); §4.6 /list 加 Branch trade-off 显式 doc (UX vs leakage, Codex-W2); §4.7 加 multi-admin 语义注解 (v0.2 退化为 first-listed admin, plural env var 兼容上游, Codex-W3); §8 新增 3 'Decision deferred to /spec (with bounds)' entries: spurious 重连 handshake 协议 (Claude-W2) / quarantine queue drain notification 路径 (Claude-W4) / zero-loss test multi-session shortid tracking harness (Claude-W6) — 三者均带明确 bounds + 推荐机制留 /spec 实现。Codex Round 3 first attempt stalled (0 bytes after 46min) → killed and retried with medium reasoning_effort + 5min timeout, retry succeeded with 3 findings (codex_consecutive_failures reset to 0)。 | /prd amendment Round 3 dual-evaluator (Claude auditor + codex exec retry); merged 11 substantive findings (0 Critical / 11 Warning, batch-accept 8 + defer 3) |
| 2026-05-15 | 2.0 | v0.2 amendment Round 4 Claude-only batch fix (4 NEW findings, all Warnings — saturation visibility, no Critical found by either evaluator since Round 2): §4.5 outbound chat-type cache cold-start lazy-fetch via getChat 桥接 (W1 — Flow B startup-without-inbound 不再 silently 失败); §4.7 admin 状态文件 0600 + protected dir colocation (W2 — sibling files 权限位完整性); §4.7 multi-admin alert 路由退化注解 (W3 — clarify v1.9 multi-admin annotation 在告警维度也按 first-listed); §4.7 launchd wait-for-reset 提示三流投递 — stderr + macOS Notification + MCP handshake disconnect_reason (W4 — admin 不再陷入 stderr-only 静默等待)。Codex Round 4 first attempt + retry 均 stalled (consistent codex CLI / OpenAI API instability for this PRD's prompt size); codex_consecutive_failures = 1; Round 4 STEP 2 merged Claude-only per Sync Protocol Rule 3。 | /prd amendment Round 4 Claude auditor only (codex absent); 4 substantive findings batch-accept |

---

## 10. Glossary

See `docs/GLOSSARY.md` (auto-generated by /prd Phase 3.3 bootstrap and appended to by
/spec Phase 2.6 for technical concepts).
