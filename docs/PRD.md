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

**Trigger**：用户在 Mac 终端跑 `claude --channels telegram`，启用 TG 通道。daemon 此时已在
后台运行。

**Steps**：
1. claude 会话与 daemon 建立 MCP 连接，注册自己（自带 identity 标签：项目路径 + 分支 +
   shortid，但 daemon 对外仅以 shortid 引用以避免路径泄漏）。daemon 把这个会话加入 "已注册
   LRU 列表"。
2. 用户从 TG 给 bot 发文本 "现在 cargo test 还跑着吗"。daemon **必须先验证 sender user_id
   在 admin allowlist**——非 admin 的入站文本一律静默忽略，**不**路由到任何 claude 会话
   （和 §3.3 callback 验证同样的安全要求；详见 §4.6 acceptance）。
3. daemon 收到合法 sender 的消息后，按"daemon-side 接收时刻的 LRU snapshot"决定路由目标：
   取最近 MCP tool 调用时间戳最近的已注册会话作为 focus（**routing snapshot rule**，见验收）。
4. daemon 把消息送达 focus 会话的 MCP transport，claude 可在 LLM 决策回路里直接读到。
5. claude 决定回复，调 MCP `reply` 把回复内容发回。daemon 调 Telegram API。
6. 用户在 TG 看到回复。

**Routing snapshot rule（确定性规则）**：
- 每条入站 TG 消息在**daemon 接收时刻**做一次 LRU 决策，使用那一瞬间的 LRU snapshot。
- 已发出的 `reply` / `react` 等 MCP tool 调用**会**更新 LRU 时间戳；TG 消息的到达本身**不**
  更新 LRU。
- 用户在 TG 用 `/session <name>` 显式切换 → 立即把指定会话推到 LRU 头，后续入站消息按新
  snapshot。
- 多条消息密集到达：每条独立按各自接收时刻 snapshot 决策。如果 focus 会话期间调过 `reply`，
  下一条消息可能走到新的 LRU 头。这是确定性的、可预测的。

**Edge cases**：
- 没有任何会话注册（且 sender 是 admin）：daemon 在 TG 回复 "No active claude session.
  Start one with `claude --channels telegram`."。**Dedup 规则**：admin-only（非 admin 已在
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
  确认或继续。**SLO 含义**：§5 的 `reply` P95 < 2s 测量**只统计 `{delivered: true}`** 的
  样本；queued 样本不参与 SLO 统计也不算 SLO 违规。如果 quarantine 期间太长（默认 5 分钟），
  daemon 在 TG 用备用通道通知用户 "daemon polling degraded"。

**Success condition**：消息送达用户 P95 < 2s；任何失败都对 claude 显式可见（不静默丢失）。

### 3.3 Flow C — Approval round-trip（关键路径）

**Trigger**：claude 准备做敏感操作（`git push --force`、`rm -rf node_modules`、`gh release
create` 等），希望先得到用户确认。

**Steps**：
1. claude 调 MCP `request_approval`：给出审批文本 + N 个选项。
2. daemon 在 TG 发带 inline-button 的消息给 admin，本地追踪这个 pending 审批（关联到 requester
   会话）。
3. 用户在 TG 看到带按钮的消息，点 "Approve"。
4. daemon **验证按钮回调的发送人 user_id 在 admin allowlist 里**（见 §3 安全验收），匹配上
   pending → 把所选选项返回给 requester 会话的 MCP 响应通道。
5. claude 拿到所选项字符串，继续执行。

**Edge cases**：
- 路由不依赖 LRU：审批回调通过 daemon 内部的 pending-id 精确路由到原 requester 会话，即使
  期间用户切换了 `/session`、或其他会话抢了 LRU focus。多会话同时 request_approval 不串台。
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
  requester 元数据），按钮无害保留可重复点击。
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
- **download_attachment**：能力 = 下载 TG 托管文件并返回本地路径；附件文件存放在 daemon
  管理的临时目录，daemon 周期清理（具体 TTL 由 /spec 决定）；外部行为与官方等价。
- **request_approval**（新增）：能力 = 发出带 inline-button 选项的消息 + 同步 await 用户
  点击结果。返回值至少包含用户选择的选项标签字符串（完整返回 schema 由 /spec 锁定）。
  安全要求：daemon **必须**验证 callback_query 的发送人 user_id 在 admin allowlist 才
  匹配 pending，非 admin 点击静默忽略。**容量超限**：当系统中 pending 审批数已达 50 时
  （见 §5 容量边界），新的**第 51 个** `request_approval` 调用立即返回
  `CapacityExceededError`，requester 可选择等待 pending 排空、cancel、或降级到普通 reply
  文本审批。
- **兼容性可测试性**：4 个官方工具的 input / output JSON schema 必须能验证上游 0.0.6 同名
  工具的对应 schema（schema-level 等价）；该等价性由 M1 milestone 的 compat 测试套件
  自动验证。
- **不**新增 `claim_focus` / `get_focus_state` 工具（见 §7 explicitly out of scope）。

### 4.6 Per-session opt-in + LRU routing

**Description**：claude 会话只有显式启用 `--channels telegram` 才接入 daemon。多个启用了的
会话按 LRU 路由，用户可在 TG 用命令显式切换。

**Acceptance criteria**：
- 没启用 TG 通道的 claude 会话对 daemon 完全不可见，不参与路由命中。
- LRU 更新：MCP tool 调用更新对应会话的最近活动时间戳；TG 消息到达**不**更新 LRU。
- 入站消息路由按 §3.1 routing snapshot rule。
- 用户在 TG 发 `/session <shortid>`：daemon 解析 `<shortid>`，把匹配会话推到 LRU 头并发
  ack。**输入消毒**：`<shortid>` 必须是 12 字符以内的纯 hex（`[a-f0-9]{1,12}`），不匹配
  此规范的输入直接拒绝并回 "Invalid shortid format"；ack 文本中只 echo 校验过的 shortid，
  防止 shell metachar / control char / 超长字符串 / TG link-preview 触发。未匹配到任何
  shortid 时回 "Session <shortid> not found"。
- 用户在 TG 发 `/list`：daemon 返回当前已注册会话列表，每行格式 `<shortid>  <branch>  <ago>`
  ——**不**输出项目路径以避免雇主 / 内部仓库名等敏感信息泄漏；空列表回复 "No sessions
  registered. Start with `claude --channels telegram`." **该回复不受 §3.1 "no session
  入站文本节流" 限制——`/list` 是 admin 主动查询，独立计数器，不共享节流名额。**
- 用户在 TG 发 `/status`：daemon 返回自身健康摘要（uptime、polling 状态、quarantine？、
  最近一次入站时间、注册会话数）。
- 审批回调（callback_query）按 pending-id 精确路由到 requester 会话，**不**走 LRU。

### 4.7 First-run admin registration

**Description**：daemon 首次启动且未配置 admin 时，进入有限时间的注册窗口；窗口内收到合规
DM 即注册。

**User value**：免去用户去 `@userinfobot` 查自己 TG user ID 复制粘贴；同时保留 env 变量
路径让和上游一致的迁移用户零摩擦。

**Acceptance criteria**：
- 如果环境变量 `TELEGRAM_AUTHORIZED_USERS` 设置 → 直接用，跳过注册流程。
- 否则 daemon 启动后进入注册模式：
  - daemon 在 stderr / launchd log / 第一个连接的 claude MCP 会话日志输出**注册码**（一个
    短随机串，比如 6 位字母数字），同时打印"Send `register <code>` to bot from your Telegram
    account within 5 minutes to claim admin"
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
    安全计算（32⁶ × 5min / 30 ≈ 10¹⁰ 年破解期望），改动该数字必须重新做安全计算。
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

---

## 5. Non-functional requirements

- **稳定性 (P0)**：
  - 连续 72 小时无长 MCP 断连：测量方法 = 启 daemon + 3 个 claude --channels telegram 会话
    + 每 30 分钟跑一次 `/reload-plugins`。**时间窗粒度**：把 72h 切成 864 个 5 分钟窗口，
    要求 ≥99% 窗口（即 ≤8 个 5min 窗口）内**零** MCP 重连事件；任何**单次连续断连 > 5 分钟**
    直接判 fail（不参与百分比统计，直接破规）。
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
  - **Redaction**：bot token、TG user IDs、用户 DM 文本内容（可能含 secret / 代码 / 路径）、
    session identity 中的项目路径段、**注册码**（5 分钟有效期的短期秘密，与 bot token 同等
    敏感），在日志里全部脱敏；只保留 hash / 长度 / 时间戳等元信息
  - `status` 子命令返回 daemon 健康摘要（同样脱敏）
  - **告警**：daemon 进入 quarantine、watchdog 触发失败退出、auth 拒绝事件（限流）通过 TG
    主动通知 admin
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
- **从上游迁回的 rollback 路径**：用户可以通过 `uninstall-daemon` + 删 admin 状态文件
  + 卸载本插件 + 重装上游 `external_plugins/telegram` 完成 rollback。两个插件**不可同时
  启用**（会撞 token）。
  - **Rollback 触发条件**：(a) 72h soak 期间出现 ≥1 次未在 5 分钟内自愈的入站失聪事件；
    (b) 出现任何 daemon 之外的进程被本插件 SIGTERM 的事件；(c) request_approval 在 24h 内
    出现 ≥3 次"用户点击但 claude 未收到"的丢失事件。
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

### 7.1 Milestones

| Milestone | User-visible capability | Gating decisions |
|---|---|---|
| M0 | "我能在终端启用 TG 通道，发一条 reply，TG 那边能收到" | daemon 启动 / 单 MCP 会话 / 单工具路径 E2E |
| M1 | "官方插件的 4 个工具我这里都能用，没有功能回归" | 4 个官方 MCP 工具行为兼容性验证；first-run 注册码流程；env-var 兼容 |
| M2 | "开 2-3 个 claude 都启用 TG，TG 消息路由到对的会话；reload-plugins 不掉" | LRU 路由 + opt-in + `/session` `/list` `/status`；RC#2 修复验证 |
| M3 | "claude 能调一次 API 等我审批，我点按钮它继续；非 admin 点击被忽略" | `request_approval` + callback auth 验证 + pending 路由不依赖 LRU |
| M4 | "连续 72 小时挂着 daemon 不掉线，日志可查；rollback 到上游有文档" | 72h soak 通过；watchdog + polling reliability + launchd 整合验证；rollback 文档；上游 PR (RC#1/RC#3 最小补丁) 草稿 |

---

## 8. Assumptions & open risks

- **Assumption**：单机单用户场景持续到 v0.2 全部生命周期。confirmed 2026-05-12 brainstorm Q1。
- **Assumption**：用户已经熟悉官方插件的 `--channels telegram` 启用模式，迁移到本插件后保留
  同样心智模型。confirmed 2026-05-12 brainstorm Q3。
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
  快速 crash-restart（launchd 重启）合并为单条告警（合并窗口由 /spec 决定，上下界 30s-
  10min）。decided 2026-05-12 Round 2 review。
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

---

## 10. Glossary

See `docs/GLOSSARY.md` (auto-generated by /prd Phase 3.3 bootstrap and appended to by
/spec Phase 2.6 for technical concepts).
