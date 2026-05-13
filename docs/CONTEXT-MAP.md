# Context Map

> Last generated: 2026-05-13
> Generated-from:
>   REQUIREMENTS_REGISTRY.md (mtime newest),
>   modules/*.md (8 module docs),
>   PRD.md (mtime newest),
>   ARCHITECTURE.md (mtime newest),
>   IMPLEMENTATION_ORDER.md,
>   docs/adr/*.md (none yet — ADR set empty)

Per `/spec` Phase 3.3 + Decision A7: 4 PRD-scoped routing entries + 1 cross-cutting catch-all
for `/dev` PLAN to use when loading narrow context instead of scanning every MODULE doc.

---

### Scope: Inbound chat / outbound push / approval (user flows)

Primary PRD topics:
- `docs/PRD.md` §3 Core user flows (Flow A bidirectional chat, Flow B push, Flow C approval)
- `docs/PRD.md` §4.5 MCP tool surface

REQ-IDs owned by this scope: REQ-001, REQ-002, REQ-003, REQ-008, REQ-009.

Required modules:
- `docs/modules/MODULE-004-mcp-tools.md`
- `docs/modules/MODULE-005-routing.md`

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (EventBus, StateDir)
- `docs/modules/MODULE-002-telegram-client.md` (TelegramAPIClient)
- `docs/modules/MODULE-003-mcp-server-proxy.md` (MCPTransport, framing)

Related ADRs:
- (none)

Related glossary terms:
- daemon, MCP proxy, focus session, LRU routing, routing snapshot rule, approval request, pending approval

---

### Scope: Daemon process / polling / watchdog / observability

Primary PRD topics:
- `docs/PRD.md` §4.1 Daemon process architecture
- `docs/PRD.md` §4.2 Bot polling reliability (RC#1 fix)
- `docs/PRD.md` §4.3 Self-aware lifecycle (RC#2 fix)
- `docs/PRD.md` §4.4 Watchdog (RC#3 fix)
- `docs/PRD.md` §5 NFR observability + alerting + recoverability

REQ-IDs owned: REQ-004, REQ-005, REQ-006, REQ-007, REQ-017, REQ-018, REQ-019, REQ-021, REQ-023, REQ-024, REQ-025.

Required modules:
- `docs/modules/MODULE-001-daemon-core.md`
- `docs/modules/MODULE-002-telegram-client.md`
- `docs/modules/MODULE-008-observability.md`

Infrastructure modules (read-only):
- (none — these three are the foundation)

Related ADRs:
- (none)

Related glossary terms:
- daemon, quarantine mode

---

### Scope: Permission / first-run / brute-force defense / TG commands

Primary PRD topics:
- `docs/PRD.md` §4.6 Per-session opt-in + LRU routing + commands
- `docs/PRD.md` §4.7 First-run admin registration
- `docs/PRD.md` §3.1 step 2 admin verification
- `docs/PRD.md` §3.3 step 4 callback admin verification

REQ-IDs owned: REQ-010, REQ-011, REQ-013, REQ-014, REQ-015, REQ-016.

Required modules:
- `docs/modules/MODULE-005-routing.md` (admin gate enforcement, /session/list/status commands)
- `docs/modules/MODULE-006-admin-auth.md` (allowlist data, registration window)

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (StateDir for admin.json, EventBus)
- `docs/modules/MODULE-002-telegram-client.md` (TG sendMessage for command replies)

Related ADRs:
- (none)

Related glossary terms:
- focus session, LRU routing, routing snapshot rule, registration window

---

### Scope: Deployment / launchd / rollback / plugin format

Primary PRD topics:
- `docs/PRD.md` §4.8 launchd integration
- `docs/PRD.md` §6 Technical constraints
- `docs/PRD.md` §7 Scope boundaries (rollback path)

REQ-IDs owned: REQ-012, REQ-026, REQ-027, REQ-028, REQ-029, REQ-030.

Required modules:
- `docs/modules/MODULE-007-deployment.md`

Infrastructure modules (read-only):
- `docs/modules/MODULE-001-daemon-core.md` (StateDir, DeploymentMode)
- `docs/modules/MODULE-006-admin-auth.md` (CONTRACT-015 AdminStateReset for reset-admin CLI)
- `docs/modules/MODULE-008-observability.md` (CONTRACT-014 StatusReporter for status CLI)

Related ADRs:
- (none)

Related glossary terms:
- daemon, registration window

---

### Scope: Cross-cutting / infrastructure

Modules whose `§1.1 Serves PRD topics` equals "infrastructure" or "cross-cutting":
- `docs/modules/MODULE-001-daemon-core.md` (foundation; cross-cutting REQ-031 Bun runtime, REQ-016 perms primary)
- `docs/modules/MODULE-003-mcp-server-proxy.md` (cross-cutting REQ-032 stateless MCP proxy)

REQ-IDs owned by this scope: REQ-020 (latency cross-module), REQ-022 (capacity cross-module), REQ-031 (runtime), REQ-032 (stateless proxy).

Related glossary terms:
- daemon, MCP proxy

---

## How to use this map

When `/dev` PLAN phase is invoked with a task description, it MAY:

1. Identify the most-fitting scope by keyword match.
2. Load the Required modules' §2.3 (interfaces) and §1.5 (ACs) sections — full file only for
   the module being implemented.
3. Load the Infrastructure modules' §2.3 only (read-only references).
4. Load relevant ARCHITECTURE.md sections (§3 inventory, §6.1 contracts, §10 traceability rows
   touching the scope's REQ-IDs).
5. Load the relevant PRD sections per the "Primary PRD topics" list.

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
