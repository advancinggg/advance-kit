# telegram-channels-pro

A claude-code plugin that bridges Telegram Bot API to MCP sessions via a single-instance
daemon on macOS. The daemon owns the bot token, runs the `getUpdates` long-poll loop, and
exposes a Unix-domain socket for claude session proxies to multiplex tool calls.

**v0.1 infrastructure slice** delivers the foundation:

- Single-instance file lock + stale-takeover validation (PID + binary identity).
- StateDir + 0700/0600 permission enforcement under `~/Library/Application Support/`.
- In-process EventBus (canonical 24 event types).
- Watchdog (orphan/stuck/idle, severity-graded `watchdog_signal` + pre-shutdown `alert_emit`).
- Deployment mode detection (launchd vs lazy-spawn).
- Graceful SIGTERM shutdown with subscriber flush barrier.
- Telegram getUpdates polling loop with sliding-window quarantine (60s/5-fatal threshold)
  and 409/429 segregation (RC#1 fix).
- Atomic offset persistence (`offset.json`).
- Daemon-side UDS MCP transport with length-prefixed JSON framing + per-connection FSM.
- First-run admin registration window (5min, 6-char alnum code, per-sender 5 + global 30
  brute-force counters).
- Structured JSON logs with 5-class redaction filter + 14-day retention janitor.
- Alert dispatcher with edge-triggered / one-shot / token-bucket / crash-restart merge.

Not in this slice (subsequent task):

- MCP tool handlers (reply / react / edit_message / download_attachment / request_approval).
- LRU routing of inbound TG updates to claude sessions.
- CLI subcommands (`install-daemon`, `uninstall-daemon`, `reset-admin`, `status`).
- claude-side proxy-client stdio bridge.

## Status

| Module | Description | Status |
|--------|-------------|--------|
| MODULE-001 daemon-core | Process lifecycle + EventBus + Watchdog | In progress (v0.1) |
| MODULE-002 telegram-client | Bot API + polling FSM + offset | In progress (v0.1) |
| MODULE-003 mcp-server-proxy | UDS acceptor + framing (daemon side) | In progress (v0.1) |
| MODULE-006 admin-auth | Allowlist + registration window | In progress (v0.1) |
| MODULE-008 observability | JSON logs + redaction + alert dispatcher | In progress (v0.1) |
| MODULE-004 mcp-tools | 5 MCP tool handlers | Not started |
| MODULE-005 routing | LRU routing + admin gate | Not started |
| MODULE-007 deployment | CLI subcommands + launchd plist | Not started |

## Quick start (developers)

```bash
bun install
bun test                      # run all unit + integration tests
bun run build                 # bundle src/daemon/main.ts to dist/daemon.js
bun run start                 # run the daemon (requires TELEGRAM_BOT_TOKEN env)
```

## Source layout

```
src/
  daemon/   M001 — state dir, lock, EventBus, watchdog, shutdown, main
  telegram/ M002 — API client wrappers, polling FSM, offset manager
  mcp/      M003 — UDS acceptor, frame encoder/decoder, session map
  auth/     M006 — allowlist, registration gate, state reset
  obs/      M008 — subscriber, redaction, JSON logger, alert dispatcher, status reporter
  common/   shared helpers (hash, atomic-write, file-perms)
```

See `docs/modules/MODULE-NNN-*.md` (in the repo root) for full spec documents.
