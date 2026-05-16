# Context Map

> Last generated: 2026-05-16 (/spec update v1.1.0 — v0.2 channels-integration amendment)
> Generated-from:
>   REQUIREMENTS_REGISTRY.md (mtime newest — v1.1 with 47 in-scope REQs),
>   modules/*.md (8 module docs, all v1.1.0 updated),
>   PRD.md (v2.0 post Round 4 audit),
>   ARCHITECTURE.md (v1.1.0 additive),
>   GLOSSARY.md (v1.1.0 with 11 new technical concepts),
>   IMPLEMENTATION_ORDER.md,
>   docs/adr/*.md (none yet — ADR set empty)

Per `/spec` Phase 3.3 + Decision A7: 5 PRD-scoped routing entries + 1 cross-cutting catch-all
for `/dev` PLAN to use when loading narrow context instead of scanning every MODULE doc.
v1.1.0 adds Scope E (channel-protocol adoption + chat-type DiD security) and threads new
REQ-033..REQ-047 + new glossary terms into existing scopes.

---

### Scope A: Inbound chat / outbound push / approval (user flows)

Primary PRD topics:
- `docs/PRD.md` §3 Core user flows (Flow A bidirectional chat, Flow B push, Flow C approval)
- `docs/PRD.md` §4.5 MCP tool surface

REQ-IDs owned by this scope: REQ-001, REQ-002, REQ-003, REQ-008, REQ-009, **REQ-035 (outbound chat-type DiD wraps all 4 outbound tools), REQ-036 (text-typed approval architectural enforcement), REQ-038 (capacity-full alert), REQ-039 (popup throttle)**.

Required modules:
- `docs/modules/MODULE-004-mcp-tools.md`
- `docs/modules/MODULE-005-routing.md`

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (EventBus, StateDir)
- `docs/modules/MODULE-002-telegram-client.md` (TelegramAPIClient + ChatTypeCache CONTRACT-016)
- `docs/modules/MODULE-003-mcp-server-proxy.md` (MCPTransport, framing, deliverChannelNotification)
- `docs/modules/MODULE-006-admin-auth.md` (CONTRACT-009 firstListedAdminUserId for capacity-full alert routing)

Related ADRs:
- (none)

Related glossary terms:
- daemon, MCP proxy, focus session, LRU routing, routing snapshot rule, approval request, pending approval, **channel notification, ChatTypeCache, outbound chat-type defense-in-depth, popup throttle (approval-expired), text-typed-approval architectural enforcement, multi-admin first-listed degradation**

---

### Scope B: Daemon process / polling / watchdog / observability

Primary PRD topics:
- `docs/PRD.md` §4.1 Daemon process architecture
- `docs/PRD.md` §4.2 Bot polling reliability (RC#1 fix)
- `docs/PRD.md` §4.3 Self-aware lifecycle (RC#2 fix)
- `docs/PRD.md` §4.4 Watchdog (RC#3 fix)
- `docs/PRD.md` §5 NFR observability + alerting + recoverability

REQ-IDs owned: REQ-004, REQ-005, REQ-006, REQ-007, REQ-017, REQ-018, REQ-019, REQ-021, REQ-023, REQ-024, REQ-025, **REQ-037 (quarantine outbound replay queue), REQ-043 (auth-reject aggregated alert), REQ-044 (redaction two-stream), REQ-045 (spurious reconnect classification)**.

Required modules:
- `docs/modules/MODULE-001-daemon-core.md`
- `docs/modules/MODULE-002-telegram-client.md`
- `docs/modules/MODULE-008-observability.md`

Infrastructure modules (read-only):
- `docs/modules/MODULE-003-mcp-server-proxy.md` (subscriber to quarantine events; reload-handshake recipient)
- `docs/modules/MODULE-005-routing.md` (REQ-043 aggregator publisher; routes auth-reject buckets)

Related ADRs:
- (none)

Related glossary terms:
- daemon, quarantine mode, **quarantine outbound replay queue, reload-handshake protocol, auth-reject aggregated alert, two-stream redaction invariant**

---

### Scope C: Permission / first-run / brute-force defense / TG commands

Primary PRD topics:
- `docs/PRD.md` §4.6 Per-session opt-in + LRU routing + commands
- `docs/PRD.md` §4.7 First-run admin registration
- `docs/PRD.md` §3.1 step 2 admin verification + chat-type gate
- `docs/PRD.md` §3.3 step 4 callback admin verification + chat-type gate

REQ-IDs owned: REQ-010, REQ-011, REQ-013, REQ-014, REQ-015, REQ-016, **REQ-034 (chat-type inbound gating), REQ-040 (/session strict matching), REQ-041 (shortid uniqueness), REQ-042 (download_attachment perms + filename sanitization), REQ-046 (multi-admin first-listed), REQ-047 (launchd wait-for-reset multi-stream)**.

Required modules:
- `docs/modules/MODULE-005-routing.md` (admin gate enforcement, /session/list/status commands, chat-type inbound gate, REQ-043 aggregator, REQ-047 disconnect carrier)
- `docs/modules/MODULE-006-admin-auth.md` (allowlist data, registration window, brute-force counters, REQ-046 firstListedAdminUserId, REQ-047 isWaitForReset + 3-stream notification)

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (StateDir for admin.json, EventBus, getPostBootShutdownContext for REQ-045)
- `docs/modules/MODULE-002-telegram-client.md` (TG sendMessage for command replies + sendChatAction typing)
- `docs/modules/MODULE-003-mcp-server-proxy.md` (deliverChannelNotification, shortid uniqueness, REQ-047 disconnect frame)
- `docs/modules/MODULE-004-mcp-tools.md` (REQ-042 download_attachment sanitization + 0700/0600 perms)

Related ADRs:
- (none)

Related glossary terms:
- focus session, LRU routing, routing snapshot rule, registration window, **multi-admin first-listed degradation, wait-for-reset multi-stream delivery**

---

### Scope D: Deployment / launchd / rollback / plugin format

Primary PRD topics:
- `docs/PRD.md` §4.8 launchd integration
- `docs/PRD.md` §6 Technical constraints
- `docs/PRD.md` §7 Scope boundaries (rollback path — v1.1.0 adds rollback path (d) channel-protocol regression)

REQ-IDs owned: REQ-012, REQ-026, REQ-027, REQ-028, REQ-029, REQ-030.

Required modules:
- `docs/modules/MODULE-007-deployment.md`

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (StateDir, DeploymentMode, getPostBootShutdownContext)
- `docs/modules/MODULE-006-admin-auth.md` (CONTRACT-015 AdminStateReset for reset-admin CLI)
- `docs/modules/MODULE-008-observability.md` (CONTRACT-014 StatusReporter for status CLI; v1.1.0 added 6 status fields)

Related ADRs:
- (none)

Related glossary terms:
- daemon, registration window, **wait-for-reset multi-stream delivery**

---

### Scope E: Channel-protocol adoption / security AC (v1.1.0 NEW)

Primary PRD topics:
- `docs/PRD.md` §4.9 Claude Code channel-protocol adoption (NEW in v1.6 amendment)
- `docs/PRD.md` §3.1 + §3.3 + §4.6 chat-type security AC (NEW in v1.6 amendment)
- `docs/PRD.md` §4.5 outbound chat-type defense-in-depth (NEW in v1.7 amendment)

REQ-IDs owned: REQ-033 (channel-protocol adoption — capabilities + notifications + system instructions + typing indicator + A/B parity), REQ-034 (inbound chat-type gating), REQ-035 (outbound chat-type DiD + ChatTypeCache cold-start lazy-fetch), REQ-036 (text-typed approval not consumed — architectural enforcement).

Required modules:
- `docs/modules/MODULE-003-mcp-server-proxy.md` (capabilities declaration, deliverChannelNotification, MCP instructions, shortid uniqueness, reload-handshake recipient, A/B parity gate)
- `docs/modules/MODULE-004-mcp-tools.md` (outbound chat-type DiD on 4 outbound tools, text-typed-approval architectural enforcement)
- `docs/modules/MODULE-005-routing.md` (inbound chat-type gate, ChatTypeCache primeCache side-effect, typing dispatcher)

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (EventBus for new event types; CONTRACT-001 ext getPostBootShutdownContext)
- `docs/modules/MODULE-002-telegram-client.md` (CONTRACT-016 ChatTypeCache provider + getChat method + sendChatAction)
- `docs/modules/MODULE-008-observability.md` (new event subscribers, StatusReporter v1.1.0 fields, RISK-018 alerting-during-quarantine mitigation)

Related ADRs:
- (none yet — Decision A15 / A16 / A17 / A18 / A19 / A20 / A21 / A22 / A23 are recorded as inline §8 entries in ARCHITECTURE.md; no standalone ADR files. Consider adding when next /spec rerun warrants.)

Related glossary terms:
- channel notification, ChatTypeCache, outbound chat-type defense-in-depth, reload-handshake protocol, popup throttle (approval-expired), auth-reject aggregated alert, two-stream redaction invariant, multi-admin first-listed degradation, wait-for-reset multi-stream delivery, text-typed-approval architectural enforcement, channel-protocol capability declaration

---

### Scope: Cross-cutting / infrastructure

Modules whose `§1.1 Serves PRD topics` includes infrastructure responsibilities:
- `docs/modules/MODULE-001-daemon-core.md` (foundation; cross-cutting REQ-031 Bun runtime, REQ-016 perms primary, v1.1.0 CONTRACT-001 ext getPostBootShutdownContext for REQ-045)
- `docs/modules/MODULE-003-mcp-server-proxy.md` (cross-cutting REQ-032 stateless MCP proxy, v1.1.0 channel-protocol adoption REQ-033/041/045)

REQ-IDs owned by this scope: REQ-020 (latency cross-module), REQ-022 (capacity cross-module — v1.1.0 adds quarantine queue 50-cap third edge), REQ-031 (runtime), REQ-032 (stateless proxy).

Related glossary terms:
- daemon, MCP proxy, **channel notification, channel-protocol capability declaration**

---

## How to use this map

When `/dev` PLAN phase is invoked with a task description, it MAY:

1. Identify the most-fitting scope by keyword match. For v0.2 channel-protocol work, look at Scope E first; for security tightening of inbound/outbound paths, Scope E + Scope C combined.
2. Load the Required modules' §2.3 (interfaces) and §1.5 (ACs) sections — full file only for
   the module being implemented.
3. Load the Infrastructure modules' §2.3 only (read-only references).
4. Load relevant ARCHITECTURE.md sections (§3 inventory, §6.1 contracts including v1.1.0 CONTRACT-016 + extensions, §8 Decisions A15-A23, §10 traceability rows touching the scope's REQ-IDs, §11.2 STRIDE rows for security work).
5. Load the relevant PRD sections per the "Primary PRD topics" list. For v0.2 amendment work, PRD §1.6-2.0 change-history rows summarize what shifted.

This narrows context dramatically vs. loading every MODULE-NNN doc.

## Staleness check

`/dev` should re-derive this map (or trigger `/spec` to do so) when ANY of:

- `docs/REQUIREMENTS_REGISTRY.md` mtime > `docs/CONTEXT-MAP.md` mtime
- Any `docs/modules/*.md` mtime > CONTEXT-MAP mtime
- `docs/PRD.md` mtime > CONTEXT-MAP mtime
- `docs/ARCHITECTURE.md` mtime > CONTEXT-MAP mtime
- `docs/GLOSSARY.md` mtime > CONTEXT-MAP mtime
- `docs/IMPLEMENTATION_ORDER.md` mtime > CONTEXT-MAP mtime
- Any `docs/adr/*.md` mtime > CONTEXT-MAP mtime (excluding `_TEMPLATE.md` and `_INDEX.md`)

Per spec/SKILL.md §3.3, CONTEXT-MAP regenerates unconditionally on every `/spec` rerun;
staleness detection is `/dev`'s responsibility.
