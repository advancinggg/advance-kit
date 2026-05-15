# Requirements Registry — telegram-channels-pro

> Generated: 2026-05-12 (/spec Phase 0.4.1)
> Last updated: 2026-05-15 (/spec update — merged PRD v1.6→v2.0 amendments)
> Based on: docs/PRD.md (v2.0 — post Round 4 Claude-only audit)

---

## In-Scope Requirements

Active: Y (current) / N (deprecated — excluded from coverage)
Type: Feature / NFR / Constraint
Status: Draft → Spec'd → Implemented → Verified | Partial

| REQ ID | Active | Source | Section | Description | Type | Module(s) | Status | Updated |
|--------|--------|--------|---------|-------------|------|-----------|--------|---------|
| REQ-001 | Y | PRD.md | §3.1 | Bidirectional chat: TG→focus claude session over LRU snapshot routing, admin-only inbound (flag-spelling: `--channels plugin:telegram-channels-pro@advance-kit`) | Feature | MODULE-005 | Verified | 2026-05-15 |
| REQ-002 | Y | PRD.md | §3.2 | Task completion push: outbound `reply` from any registered session to admin chat | Feature | MODULE-004 | Verified | 2026-05-15 |
| REQ-003 | Y | PRD.md | §3.3 | Approval round-trip: claude `request_approval` blocks until admin inline-button click | Feature | MODULE-004, MODULE-005 | Verified | 2026-05-15 |
| REQ-004 | Y | PRD.md | §4.1 | Daemon process architecture: single-instance, sole token holder, in-memory state, SIGTERM graceful shutdown | Feature | MODULE-001 | Verified | 2026-05-14 |
| REQ-005 | Y | PRD.md | §4.2 | Bot polling reliability: indefinite exp-backoff retry + sliding-window quarantine; 409/429 segregated from fatal counter | Feature | MODULE-002 | Verified | 2026-05-15 |
| REQ-006 | Y | PRD.md | §4.3 | Self-aware lifecycle: file lock + PID/binary-identity validation; second instance exits cleanly; never SIGTERMs other processes | Feature | MODULE-001, MODULE-003 | Verified | 2026-05-14 |
| REQ-007 | Y | PRD.md | §4.4 | Watchdog: orphan/stuck/idle detection with severity-graded observability (failures alert, voluntary idle stays quiet) | Feature | MODULE-001 | Verified | 2026-05-14 |
| REQ-008 | Y | PRD.md | §4.5 | MCP tool compatibility: reply / react / edit_message / download_attachment external behavior matches upstream 0.0.6 (JSON schema validation in M1) | Feature | MODULE-002, MODULE-004 | Verified | 2026-05-15 |
| REQ-009 | Y | PRD.md | §4.5 | `request_approval` stateful tool: inline-button + await + capacity-exceeded error at >50 pending | Feature | MODULE-004 | Verified | 2026-05-15 |
| REQ-010 | Y | PRD.md | §4.6 | Per-session opt-in via `--channels plugin:telegram-channels-pro@advance-kit` + LRU routing + `/session` `/list` `/status` TG commands | Feature | MODULE-005 | Verified | 2026-05-15 |
| REQ-011 | Y | PRD.md | §4.7 | First-run admin registration: env-var precedence + code-match registration window with launchd-mode wait-for-reset | Feature | MODULE-006, MODULE-002, MODULE-005 (forwarder) | Verified | 2026-05-14 |
| REQ-012 | Y | PRD.md | §4.8 | launchd integration: opt-out plist install + bootstrap + lazy-spawn fallback + concurrent-spawn attach | Feature | MODULE-007 | Verified | 2026-05-15 |
| REQ-013 | Y | PRD.md | §3.1+§3.3 | Admin allowlist enforcement: inbound text sender verification + callback_query sender verification (both silently drop non-admin) | Feature | MODULE-006 (data), MODULE-005 (enforcement) | Verified | 2026-05-15 |
| REQ-014 | Y | PRD.md | §4.7 | Registration brute-force defense: per-sender 5 attempts + global 30 attempts → forced reset-admin (32^6 / 2 / 30·per-5min ≈ 170-year expected break time; combined with reset-required ceiling makes break probability ≈ 0). Slice 2: in-process forceReopenForReset for M007 control socket recovery | Feature | MODULE-006 | Verified | 2026-05-14 |
| REQ-015 | Y | PRD.md | §4.6 | TG command input sanitization: `/session <shortid>` hex regex validation + ack echoes only validated string | Feature | MODULE-005 | Verified | 2026-05-15 |
| REQ-016 | Y | PRD.md | §4.3+§4.7 | Lock file + unix socket + admin state files + download_attachment temp directory: 0700 directory (ownership-matched), 0600 files, colocated under one protected directory | Constraint | MODULE-001, MODULE-006, MODULE-004 | Verified | 2026-05-14 |
| REQ-017 | Y | PRD.md | §5 | Stability SLO: 72h soak, ≥99% of 864 5-min windows zero **spurious** MCP reconnect events (scripted disconnects via `/reload-plugins` / SIGTERM / launchd KeepAlive restart excluded); single continuous >5min outage = fail. Handshake mechanism (REQ-045) classifies events | NFR | MODULE-008, MODULE-001, MODULE-003 | Draft | 2026-05-15 |
| REQ-018 | Y | PRD.md | §5 | Inbound zero-loss: Telegram offset correctness; ≥1 session-registered prerequisite during soak | NFR | MODULE-002 | Verified | 2026-05-14 |
| REQ-019 | Y | PRD.md | §5 | Zero zombie processes: 72h end, ps STAT=R + etime>1h or CPU>50% bun count = 0 | NFR | MODULE-001 | Draft | 2026-05-12 |
| REQ-020 | Y | PRD.md | §5 | Latency: inbound TG→claude P95<5s, reply→TG P95<2s (delivered-only), approval P95<3s (60s-click-window-only). Slice 2 partial: M005 in-process micro-benchmark (max<5ms) only — full E2E latency NFR deferred to soak. | NFR | MODULE-005 | Partial | 2026-05-15 |
| REQ-021 | Y | PRD.md | §5 | Resource budget: stationary RSS<50MB P95, CPU<1% mean (stationary-window measurement protocol) | NFR | MODULE-001, MODULE-008 | Partial | 2026-05-14 |
| REQ-022 | Y | PRD.md | §5 | Capacity edges: ≤8 sessions accept / >8 reject; ≤50 pending accept / >50 reject (CapacityExceededError); quarantine outbound replay queue ≤50 (REQ-037) | NFR | MODULE-005, MODULE-003, MODULE-004, MODULE-002 | Verified | 2026-05-15 |
| REQ-023 | Y | PRD.md | §5 | Structured JSON logs: event_type / session_id / request_id / error_class fields; redaction list (token, user IDs, DM body, identity path, reg code); `status` subcommand summary. Redaction scope = JSON event log only (see REQ-044 two-stream invariant) | NFR | MODULE-008 | Verified | 2026-05-14 |
| REQ-024 | Y | PRD.md | §5+§8 | Alerting: state-change edge-triggered TG notifications for quarantine entry/exit + watchdog failure + auth deny (rate-limited); crash-restart deduplication window. Auth-deny path detailed in REQ-043 (silent-drop + aggregated alert two-tier) | NFR | MODULE-008, MODULE-002, MODULE-005 (M005-side throttle counter) | Verified | 2026-05-14 |
| REQ-025 | Y | PRD.md | §5 | Recoverability: launchd KeepAlive auto-restart; pending approvals are in-memory (lost on restart); 24h Telegram retention bounds | NFR | MODULE-001, MODULE-002, MODULE-007 | Verified | 2026-05-14 |
| REQ-026 | Y | PRD.md | §7 | Rollback path to upstream: uninstall-daemon + admin state cleanup + plugin uninstall + reinstall upstream; with triggers + diagnostics + version-revert documentation. v0.2 adds partial-rollback (d) channel-protocol regression: in-version downgrade to v0.1.x patch retaining daemon, demoting inbound to log channel | Feature | MODULE-007 | Verified | 2026-05-15 |
| REQ-027 | Y | PRD.md | §6 | Platform: macOS only (Apple Silicon + Intel); v0.3+ for Linux/Windows | Constraint | MODULE-007 | Verified | 2026-05-15 |
| REQ-028 | Y | PRD.md | §6 | claude-code plugin format: advance-kit `plugins/<name>/` layout + marketplace.json + plugin.json + 3 README 5-sync-point invariant | Constraint | MODULE-007 | Verified | 2026-05-15 |
| REQ-029 | Y | PRD.md | §6 | Single-user single-machine: hard assumption; multi-tenant out of scope until v0.3+ | Constraint | MODULE-006 (perms enforcement via AC-12) | Verified | 2026-05-15 |
| REQ-030 | Y | PRD.md | §6 | Plugin namespace `telegram-channels-pro`; MCP server name uses independent identifier (no clash with upstream `telegram`) | Constraint | MODULE-007 | Verified | 2026-05-15 |
| REQ-031 | Y | PRD.md | §8 | Runtime: Bun + TypeScript (parity with upstream 0.0.6; enables RC#1/RC#3 cherry-pick upstream PRs) | Constraint | MODULE-001 | Verified | 2026-05-14 |
| REQ-032 | Y | PRD.md | §1+§3.1 | Stateless MCP proxy: claude-side plugin holds zero token / polling / pending state; all state lives in daemon | Feature | MODULE-003, MODULE-001 | Verified | 2026-05-14 |
| REQ-033 | Y | PRD.md | §4.9 | Claude Code channel-protocol adoption: `capabilities.experimental.claude/channel` declaration (NOT `claude/channel/permission`); inbound push via `notifications/claude/channel` (with chat_id/message_id/user/ts/image_path/attachment_file_id payload); structured `<channel>` tag visible to LLM; MCP `instructions` field carries system prompt (prompt-injection rejection + slash-prefix as regular text + approval-boundary "text-typed approve is not approval"); Telegram typing indicator on inbound + stop on any outbound (4 tools); multi-session LRU transparency to model; ≥5-sample A/B parity test gate vs upstream 0.0.6 | Feature | MODULE-003, MODULE-001, MODULE-002 | Draft | 2026-05-15 |
| REQ-034 | Y | PRD.md | §3.1+§3.3+§4.6 | Chat-type inbound security: daemon silently drops inbound text and callback_query whose `chat.type !== "private"` (group/supergroup/channel), including when sender is in admin allowlist; ERROR-level structured log emitted | Feature | MODULE-005, MODULE-002 | Draft | 2026-05-15 |
| REQ-035 | Y | PRD.md | §4.5 | Outbound chat-type defense-in-depth: all 4 outbound tools (reply/react/edit_message/request_approval) validate `chat_id → chat_type === private` via daemon cache (TTL 1h, LRU at 1000 entries); on cache miss, lazy-fetch via Telegram `getChat` API (Flow B cold-start bridge); non-private chat_id → `InvalidChatTypeError`; lazy-fetch network failure → refuse + log + don't cache (next call retries) | Feature | MODULE-002, MODULE-004, MODULE-005 | Draft | 2026-05-15 |
| REQ-036 | Y | PRD.md | §3.3+§4.9 | Text-typed approval is not approval: pending request_approval advances only on inline-button callback_query; text "approve" / "yes" / "好" / etc are routed as normal channel notification to focus session (anti prompt-injection of admin authority) | Feature | MODULE-004, MODULE-005, MODULE-003 (system instructions) | Draft | 2026-05-15 |
| REQ-037 | Y | PRD.md | §3.2 | Quarantine outbound replay queue: in-memory 50-cap; new reply beyond cap returns `CapacityExceededError`; daemon restart drops queue (best-effort; claude end discovers via next call error). Drain notification mechanism (REQ-045) notifies requester session on quarantine end | Feature | MODULE-002, MODULE-001 | Draft | 2026-05-15 |
| REQ-038 | Y | PRD.md | §4.5 | Approval queue capacity-full TG admin alert: when pending = 50 (REQ-009 threshold), daemon sends one-time TG admin alert "Approval queue full (50 pending) — claude tool calls failing. Complete or cancel pending approvals." with 5-min throttle | Feature | MODULE-004, MODULE-008 | Draft | 2026-05-15 |
| REQ-039 | Y | PRD.md | §3.3 | Approval-expired popup throttle: same `callback_query.data` returns popup only once per 5-min sliding window; subsequent clicks accepted (callback answered) but no popup; info-leak defense against repeated-click probing | Feature | MODULE-004, MODULE-005 | Draft | 2026-05-15 |
| REQ-040 | Y | PRD.md | §4.6 | `/session` strict matching mode: regex `^/session [a-f0-9]{1,12}$` (full-line anchor); embedded `/session abc` in message body routed as regular text to focus session (defends against focus-redirect injection via composite messages) | Feature | MODULE-005 | Draft | 2026-05-15 |
| REQ-041 | Y | PRD.md | §4.6 | Shortid uniqueness invariant: daemon-assigned shortid is unique within active session set; collisions during generation trigger regeneration; session exit releases shortid; no cross-daemon-restart shortid consistency (sessions reconnect and receive new shortid) | Feature | MODULE-003, MODULE-005 | Draft | 2026-05-15 |
| REQ-042 | Y | PRD.md | §4.5 | `download_attachment` file system protection: file placed in 0700 protected directory (REQ-016 colocation); file itself 0600; on-disk filename = random hash (16 hex chars) + sanitized extension (`^[a-zA-Z0-9]{1,8}$` else drop); rejects path-traversal / shell-metachar from TG-provided filename; periodic janitor cleanup with 4-hour TTL | Feature | MODULE-004 | Draft | 2026-05-15 |
| REQ-043 | Y | PRD.md | §5 | Auth-reject silent-drop + aggregated alert: per-event silent drop at protocol layer (no echo to attacker); ERROR-level structured JSON log on each event; aggregate threshold-triggered TG admin alert ("auth reject burst: {category}, {count} events in 5min") — thresholds: per-sender 5 / global 30 / non-admin-chat 10 / non-private-chat 10; 5-min sliding window; alert frequency ≤ 1/hour per category | NFR | MODULE-005, MODULE-008 | Draft | 2026-05-15 |
| REQ-044 | Y | PRD.md | §4.7+§5 | Redaction two-stream invariant: registration code (5-min short-term secret) stays **plaintext** in user-facing delivery channels (stderr + launchd log + first MCP session log per REQ-047) but redacted in structured JSON event log (REQ-023 scope). Other sensitives (bot token, user IDs, DM body, identity path) appear only in JSON event log and are always redacted there | Constraint | MODULE-006, MODULE-008 | Draft | 2026-05-15 |
| REQ-045 | Y | PRD.md | §5+§8 | Spurious MCP reconnect classification: claude-side proxy emits `tgcp/proxy/will_reconnect` MCP notification immediately before transport close on `/reload-plugins` trigger; daemon receives the frame and marks the next reconnect from the same proxy-id as scripted (excluded from REQ-017 SLO). SIGTERM-initiated and launchd-KeepAlive-initiated reconnects identified via daemon-side process-lifecycle signal handlers. Quarantine drain notification path: daemon emits `tgcp/quarantine/reply_resolved` MCP notification on each queued reply replay (with delivered/queued status), `tgcp/quarantine/state_changed` on quarantine entry/exit | Feature | MODULE-008, MODULE-001, MODULE-003 | Draft | 2026-05-15 |
| REQ-046 | Y | PRD.md | §4.7 | Multi-admin first-listed degradation: `TELEGRAM_AUTHORIZED_USERS` accepts comma-separated user_ids (upstream env-var compat); v0.2 hard-supports 1 admin (REQ-029); multi configured → all outbound notifications (REQ-002), pending approval routing (REQ-009), ops alerts (REQ-024, REQ-038, REQ-043) use first-listed user_id only; other user_ids permit inbound text but receive no ops traffic | Constraint | MODULE-006, MODULE-005, MODULE-008 | Draft | 2026-05-15 |
| REQ-047 | Y | PRD.md | §4.7 | launchd wait-for-reset multi-stream delivery: on registration timeout (launchd mode), daemon emits "registration timed out; run reset-admin to retry" via (a) stderr every 5min until reset, (b) one-time macOS Notification Center (`osascript -e 'display notification'` invoked once on wait-for-reset entry, throttled to non-repeating), (c) any MCP handshake returns disconnect with `disconnect_reason` carrying the hint | Feature | MODULE-006, MODULE-007, MODULE-003 | Draft | 2026-05-15 |

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
| OUT-009 | PRD.md §7 | Channel-permission relay replacement of `request_approval` (`notifications/claude/channel/permission_request`) | Bespoke MCP tool retained; v0.1.x approval round-trip proven; pending-state + capacity-edge + callback-auth logic independent of channel layer |
| OUT-010 | PRD.md §7 | Official ACCESS.md 6-char pairing-code DM flow | First-run code window + dual brute-force counter (REQ-014) already proven; pairing is UX simplification, not security upgrade; multi-user revisit at v0.3+ |

---

## Coverage

- In-scope Active=Y REQ-IDs: 47 (was 32; +15 from v1.6→v2.0 amendments)
- Out-of-scope: 10 (was 8; +2)
- Coverage formula: `count(Module mapping non-empty for Active=Y) / count(Active=Y) × 100`
- Target: 100% after Phase 1 ARCHITECTURE.md regen
- Current: 100% (all Active=Y REQs have Module(s) populated)

## REQ-ID Stability

History of stability events:
- 2026-05-12 — Initial registry generation (32 REQs, all new)
- 2026-05-15 — Update mode (/spec update): 5 REQs description-updated (REQ-001 / REQ-010 / REQ-014 / REQ-016 / REQ-017 — none semantically replaced; flag-spelling, math correction, scope-expand additions); 15 new REQs added (REQ-033 .. REQ-047); 2 new OUT (OUT-009, OUT-010). All existing REQ-IDs preserved; no deprecation this round.

Stability rules going forward:
- Unchanged Description → preserve REQ ID
- Changed Description (semantically different) → set old Active=N, assign new REQ-{next}
- New REQ → next available REQ-{NNN}, never reuse deprecated IDs
- Removed REQ → Active=N (do not delete row)

## Status Transitions

- Draft (this run, before Phase 1.4) → Spec'd (after MODULE assignment)
- Spec'd → Implemented (after /dev IMPLEMENT phase commits)
- Implemented → Verified (after /dev SUMMARY phase passes all Active=Y AC)
- Implemented → Partial (after /dev SUMMARY phase has some untested AC)

**Note on REQ-033..047 statuses**: all new REQs initialized at Draft (not Spec'd) because /spec update is mid-flow at the time of this write; once ARCHITECTURE + module updates land in this same /spec invocation they will transition to Spec'd before final commit. /dev SUMMARY runs after this /spec invocation transition them through Implemented/Verified.
