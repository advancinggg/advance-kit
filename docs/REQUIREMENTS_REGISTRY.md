# Requirements Registry — telegram-channels-pro

> Generated: 2026-05-12 (/spec Phase 0.4.1)
> Based on: docs/PRD.md (v1.5)

---

## In-Scope Requirements

Active: Y (current) / N (deprecated — excluded from coverage)
Type: Feature / NFR / Constraint
Status: Draft → Spec'd → Implemented → Verified | Partial

| REQ ID | Active | Source | Section | Description | Type | Module(s) | Status | Updated |
|--------|--------|--------|---------|-------------|------|-----------|--------|---------|
| REQ-001 | Y | PRD.md | §3.1 | Bidirectional chat: TG→focus claude session over LRU snapshot routing, admin-only inbound | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-002 | Y | PRD.md | §3.2 | Task completion push: outbound `reply` from any registered session to admin chat | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-003 | Y | PRD.md | §3.3 | Approval round-trip: claude `request_approval` blocks until admin inline-button click | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-004 | Y | PRD.md | §4.1 | Daemon process architecture: single-instance, sole token holder, in-memory state, SIGTERM graceful shutdown | Feature | MODULE-001 | Implemented | 2026-05-14 |
| REQ-005 | Y | PRD.md | §4.2 | Bot polling reliability: indefinite exp-backoff retry + sliding-window quarantine; 409/429 segregated from fatal counter | Feature | MODULE-002 | Implemented | 2026-05-14 |
| REQ-006 | Y | PRD.md | §4.3 | Self-aware lifecycle: file lock + PID/binary-identity validation; second instance exits cleanly; never SIGTERMs other processes | Feature | MODULE-001, MODULE-003 | Implemented | 2026-05-14 |
| REQ-007 | Y | PRD.md | §4.4 | Watchdog: orphan/stuck/idle detection with severity-graded observability (failures alert, voluntary idle stays quiet) | Feature | MODULE-001 | Implemented | 2026-05-14 |
| REQ-008 | Y | PRD.md | §4.5 | MCP tool compatibility: reply / react / edit_message / download_attachment external behavior matches upstream 0.0.6 (JSON schema validation in M1) | Feature | MODULE-002, MODULE-004 | Implemented | 2026-05-14 |
| REQ-009 | Y | PRD.md | §4.5 | `request_approval` stateful tool: inline-button + await + capacity-exceeded error at >50 pending | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-010 | Y | PRD.md | §4.6 | Per-session opt-in via `--channels telegram` + LRU routing + `/session` `/list` `/status` TG commands | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-011 | Y | PRD.md | §4.7 | First-run admin registration: env-var precedence + code-match registration window with launchd-mode wait-for-reset | Feature | MODULE-006, MODULE-002 | Implemented | 2026-05-14 |
| REQ-012 | Y | PRD.md | §4.8 | launchd integration: opt-out plist install + bootstrap + lazy-spawn fallback + concurrent-spawn attach | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-013 | Y | PRD.md | §3.1+§3.3 | Admin allowlist enforcement: inbound text sender verification + callback_query sender verification (both silently drop non-admin) | Feature | MODULE-006 (data), MODULE-005 (enforcement) | Implemented | 2026-05-14 |
| REQ-014 | Y | PRD.md | §4.7 | Registration brute-force defense: per-sender 5 attempts + global 30 attempts → forced reset-admin | Feature | MODULE-006 | Implemented | 2026-05-14 |
| REQ-015 | Y | PRD.md | §4.6 | TG command input sanitization: `/session <shortid>` hex regex validation + ack echoes only validated string | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-016 | Y | PRD.md | §4.3 | Lock file + socket + admin state files: 0600 ownership-matched-to-uid + colocated under one protected directory | Constraint | MODULE-001, MODULE-006 | Implemented | 2026-05-14 |
| REQ-017 | Y | PRD.md | §5 | Stability SLO: 72h soak, ≥99% of 864 5-min windows zero MCP disconnect events; single continuous >5min outage = fail | NFR | (after Phase 1) | Draft | 2026-05-12 |
| REQ-018 | Y | PRD.md | §5 | Inbound zero-loss: Telegram offset correctness; ≥1 session-registered prerequisite during soak | NFR | MODULE-002 | Implemented | 2026-05-14 |
| REQ-019 | Y | PRD.md | §5 | Zero zombie processes: 72h end, ps STAT=R + etime>1h or CPU>50% bun count = 0 | NFR | (after Phase 1) | Draft | 2026-05-12 |
| REQ-020 | Y | PRD.md | §5 | Latency: inbound TG→claude P95<5s, reply→TG P95<2s (delivered-only), approval P95<3s (60s-click-window-only) | NFR | (after Phase 1) | Draft | 2026-05-12 |
| REQ-021 | Y | PRD.md | §5 | Resource budget: stationary RSS<50MB P95, CPU<1% mean (stationary-window measurement protocol) | NFR | MODULE-001, MODULE-008 | Implemented | 2026-05-14 |
| REQ-022 | Y | PRD.md | §5 | Capacity edges: ≤8 sessions accept / >8 reject; ≤50 pending accept / >50 reject (CapacityExceededError) | NFR | MODULE-005, MODULE-003, MODULE-004 | Implemented | 2026-05-14 |
| REQ-023 | Y | PRD.md | §5 | Structured JSON logs: event_type / session_id / request_id / error_class fields; redaction list (token, user IDs, DM body, identity path, reg code); `status` subcommand summary | NFR | MODULE-008 | Implemented | 2026-05-14 |
| REQ-024 | Y | PRD.md | §5+§8 | Alerting: state-change edge-triggered TG notifications for quarantine entry/exit + watchdog failure + auth deny (rate-limited); crash-restart deduplication window | NFR | MODULE-008, MODULE-002 | Implemented | 2026-05-14 |
| REQ-025 | Y | PRD.md | §5 | Recoverability: launchd KeepAlive auto-restart; pending approvals are in-memory (lost on restart); 24h Telegram retention bounds | NFR | MODULE-001, MODULE-002, MODULE-007 | Implemented | 2026-05-14 |
| REQ-026 | Y | PRD.md | §7 | Rollback path to upstream: uninstall-daemon + admin state cleanup + plugin uninstall + reinstall upstream; with triggers + diagnostics + version-revert documentation | Feature | (after Phase 1) | Draft | 2026-05-12 |
| REQ-027 | Y | PRD.md | §6 | Platform: macOS only (Apple Silicon + Intel); v0.3+ for Linux/Windows | Constraint | (after Phase 1) | Draft | 2026-05-12 |
| REQ-028 | Y | PRD.md | §6 | claude-code plugin format: advance-kit `plugins/<name>/` layout + marketplace.json + plugin.json + 3 README 5-sync-point invariant | Constraint | (after Phase 1) | Draft | 2026-05-12 |
| REQ-029 | Y | PRD.md | §6 | Single-user single-machine: hard assumption; multi-tenant out of scope until v0.3+ | Constraint | (after Phase 1) | Draft | 2026-05-12 |
| REQ-030 | Y | PRD.md | §6 | Plugin namespace `telegram-channels-pro`; MCP server name uses independent identifier (no clash with upstream `telegram`) | Constraint | (after Phase 1) | Draft | 2026-05-12 |
| REQ-031 | Y | PRD.md | §8 | Runtime: Bun + TypeScript (parity with upstream 0.0.6; enables RC#1/RC#3 cherry-pick upstream PRs) | Constraint | MODULE-001 | Implemented | 2026-05-14 |
| REQ-032 | Y | PRD.md | §1+§3.1 | Stateless MCP proxy: claude-side plugin holds zero token / polling / pending state; all state lives in daemon | Feature | MODULE-003, MODULE-001 | Implemented | 2026-05-14 |

## Scope Exclusions

| REQ ID | Source | Description | Reason |
|--------|--------|-------------|--------|
| OUT-001 | PRD.md §7 | Webhook mode | Continue long-polling; webhook needs public ingress, no value for single-machine single-user |
| OUT-002 | PRD.md §7 | Multi-user / multi-token / multi-tenant | Single-user assumption is hard; auth/isolation/quota complexity deferred to v0.3+ |
| OUT-003 | PRD.md §7 | `claim_focus` / `get_focus_state` MCP tools | Multi-session contention rare; `/session` handles it; avoid daemon state-machine bloat |
| OUT-004 | PRD.md §7 | TSGram-style dangerzone / safetyzone tiered permissions | Single-admin scenario makes tiered perms meaningless until multi-user (v0.3+) |
| OUT-005 | PRD.md §7 | CCGram Smart Suppression (terminal-active mute) | Value < cost; revisit v0.3+ |
| OUT-006 | PRD.md §7 | Stale message drop (>20min) | Latency bottleneck eliminated by daemon arch; feature need disappeared |
| OUT-007 | PRD.md §7 | Cross-machine routing | Single-machine assumption |
| OUT-008 | PRD.md §7 | Pending approval persistence across daemon restart | In-memory; user retriggers `request_approval` on crash |

---

## Coverage

- In-scope Active=Y REQ-IDs: 32
- Out-of-scope: 8
- Coverage formula: `count(Module mapping non-empty for Active=Y) / count(Active=Y) × 100`
- Target: 100% after Phase 1 ARCHITECTURE.md generation
- Current: 0% (Module(s) column populated in Phase 1.4)

## REQ-ID Stability

This is the initial registry generation. Subsequent /spec reruns honor stability rules:
- Unchanged Description → preserve REQ ID
- Changed Description → set old Active=N, assign new REQ-{next}
- New REQ → next available REQ-{NNN}, never reuse deprecated IDs
- Removed REQ → Active=N

## Status Transitions

- Draft (this run, before Phase 1.4) → Spec'd (after MODULE assignment)
- Spec'd → Implemented (after /dev IMPLEMENT phase commits)
- Implemented → Verified (after /dev SUMMARY phase passes all Active=Y AC)
- Implemented → Partial (after /dev SUMMARY phase has some untested AC)
