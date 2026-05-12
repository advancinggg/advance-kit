# Glossary

> Created: 2026-05-12 (/prd bootstrap)
> Last updated: 2026-05-12

---

## Business terms

### daemon
**Definition**: telegram-channels-pro 体系内独占 bot token 并负责 Telegram getUpdates 长轮询的单一常驻进程；由 launchd 拉起或被首个启用 TG 通道的 claude 会话 lazy spawn；与 claude 会话之间通过进程间通信通道（具体形式由 /spec 决定）通信。
**Synonyms**: bot daemon, polling daemon, telegram daemon
**Related**: MCP proxy, focus session, quarantine mode
**Source**: /prd brainstorm Q1+Q3

### MCP proxy
**Definition**: claude 会话进程内运行的薄客户端组件，作为 daemon 的 stateless 代理向 claude 暴露 MCP 工具表面；自己不持有 bot token、不做 polling、不存 pending state；所有 MCP 工具调用通过进程间通道转发到 daemon 执行。
**Synonyms**: thin client, claude-side proxy, in-session MCP server
**Related**: daemon, focus session
**Source**: /prd Round 1 review

### focus session
**Definition**: 在多 claude 会话同时注册的情况下，被 LRU 路由策略选中接收下一条入站 Telegram 文本消息的那个 claude 会话；最近 MCP tool 活动时间戳决定 focus 归属，用户可在 TG 用 /session 命令显式切换。
**Synonyms**: active session, routing target
**Related**: daemon, LRU routing, routing snapshot rule
**Source**: /prd brainstorm Q3

### LRU routing
**Definition**: telegram-channels-pro daemon 选择入站 Telegram 消息送达目标会话的策略；维护已注册会话的有序列表，按"最近一次 MCP tool 调用时间戳"排序，列表头即 focus；MCP tool 调用更新时间戳，入站 TG 消息到达不更新。
**Synonyms**: least-recently-used routing, focus selection policy
**Related**: focus session, routing snapshot rule
**Source**: /prd brainstorm Q3

### routing snapshot rule
**Definition**: telegram-channels-pro 路由决策的确定性规则——每条入站 TG 消息在 daemon 接收时刻基于当时的 LRU snapshot 决定目标会话；密集到达的多条消息各自独立按各自接收时刻 snapshot 决策；reply 等 MCP 调用会更新 LRU 时间戳，TG 消息到达本身不更新。
**Synonyms**: per-message snapshot routing
**Related**: LRU routing, focus session
**Source**: /prd Round 1 review

### approval request
**Definition**: claude 会话调用 request_approval 工具发起的同步审批操作；daemon 把 text 和 options 渲染为 Telegram inline-button 消息发给 admin，等用户点击后通过 MCP 响应通道把所选项返回给请求会话；callback 路由按 pending-id 精确定位 requester 会话不依赖 LRU；daemon 验证 callback_query 发送人 user_id 在 admin allowlist 才匹配 pending。
**Synonyms**: inline approval, sync approval
**Related**: pending approval, daemon
**Source**: /prd brainstorm Q5

### pending approval
**Definition**: daemon 端追踪的"已发出 inline-button 消息但用户尚未点击"状态记录，关联到原 requester 会话；存于 in-memory（不跨 daemon 重启保留），daemon crash 后丢失，用户原消息变 expired；requester 会话先退出则 daemon 清理 pending 并把 TG 原消息编辑为 cancelled 提示。
**Synonyms**: in-flight approval, awaiting-click state
**Related**: approval request, daemon
**Source**: /prd Round 1 review

### quarantine mode
**Definition**: daemon polling 持续异常时进入的暂停状态——根据滑动窗口失败阈值触发；进入时 daemon 通过 TG 主动通知 admin + 写 ERROR 日志 + status 子命令报告标注；冷却时长后自动尝试退出 quarantine 重新 polling；具体阈值和冷却时长由 /spec 决定。
**Synonyms**: polling pause, fatal-fail backoff
**Related**: daemon
**Source**: /prd Round 1 review

### registration window
**Definition**: daemon 首次启动且未配置 TELEGRAM_AUTHORIZED_USERS 环境变量时进入的 5 分钟开放期；窗口期间 daemon 在 stderr 输出随机注册码 + 提示信息；仅当收到的 DM 文本完全匹配 register {code} 格式且 code 正确，发送人 TG user ID 才被持久化为 admin；超时未注册或窗口外 DM 一律静默忽略。
**Synonyms**: admin registration, first-run window
**Related**: daemon
**Source**: /prd brainstorm Q6 + /prd Round 1 review

## Technical concepts

(Populated by `/spec §2.6` MODULE-generation append step.)

## Change history

| Date | Entry | Field | Driver |
|---|---|---|---|
| 2026-05-12 | daemon | created | /prd bootstrap |
| 2026-05-12 | focus session | created | /prd bootstrap |
| 2026-05-12 | approval request | created | /prd bootstrap |
| 2026-05-12 | registration window | created | /prd bootstrap |
| 2026-05-12 | MCP proxy | created | /prd Round 1 review |
| 2026-05-12 | LRU routing | created | /prd Round 1 review |
| 2026-05-12 | routing snapshot rule | created | /prd Round 1 review |
| 2026-05-12 | pending approval | created | /prd Round 1 review |
| 2026-05-12 | quarantine mode | created | /prd Round 1 review |
| 2026-05-12 | daemon | Related extended (MCP proxy, quarantine mode) | /prd Round 1 review |
| 2026-05-12 | focus session | Related extended (LRU routing, routing snapshot rule) | /prd Round 1 review |
| 2026-05-12 | approval request | definition extended (callback auth invariant) | /prd Round 1 review |
| 2026-05-12 | registration window | definition extended (code-match TOFU mitigation) | /prd Round 1 review |
