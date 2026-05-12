# Glossary

> Created: 2026-05-12 (/prd bootstrap)
> Last updated: 2026-05-12

---

## Business terms

### daemon
**Definition**: telegram-channels-pro 体系内独占 bot token 并负责 Telegram getUpdates 长轮询的单一常驻进程；由 launchd 拉起或被首个启用 TG 通道的 claude 会话 lazy spawn；与 claude 会话之间通过 unix socket 通信。
**Synonyms**: bot daemon, polling daemon, telegram daemon
**Related**: focus session, MCP proxy
**Source**: /prd brainstorm Q1+Q3

### focus session
**Definition**: 在多 claude 会话同时注册的情况下，被 LRU 路由策略选中接收下一条入站 Telegram 文本消息的那个 claude 会话；最近 MCP tool 活动时间戳决定 focus 归属，用户可在 TG 用 /session 命令显式切换。
**Synonyms**: active session, routing target
**Related**: daemon, LRU routing
**Source**: /prd brainstorm Q3

### approval request
**Definition**: claude 会话调用 request_approval 工具发起的同步审批操作；daemon 把 text 和 options 渲染为 Telegram inline-button 消息发给 admin，等用户点击后通过 MCP 响应通道把所选项返回给请求会话；callback_data 携带 requester ID 用于精确路由不依赖 LRU。
**Synonyms**: inline approval, sync approval
**Related**: focus session, daemon
**Source**: /prd brainstorm Q5

### registration window
**Definition**: daemon 首次启动且未配置 TELEGRAM_AUTHORIZED_USERS 环境变量时进入的 5 分钟开放期；窗口内收到的第一条 DM 的发送人 TG user ID 被持久化为 admin；超时或注册成功后窗口关闭，未授权 DM 一律静默忽略。
**Synonyms**: admin registration, first-run window
**Related**: daemon
**Source**: /prd brainstorm Q6

## Technical concepts

(Populated by `/spec §2.6` MODULE-generation append step.)

## Change history

| Date | Entry | Field | Driver |
|---|---|---|---|
| 2026-05-12 | daemon | created | /prd bootstrap |
| 2026-05-12 | focus session | created | /prd bootstrap |
| 2026-05-12 | approval request | created | /prd bootstrap |
| 2026-05-12 | registration window | created | /prd bootstrap |
