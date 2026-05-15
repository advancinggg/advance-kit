# 72h Soak Validation Runbook — telegram-channels-pro

> Closes the 4 NFR / E2E ACs that unit tests cannot cover:
> M001-AC-15 (REQ-019 zero zombies), M001-AC-16 (REQ-021 RSS<50MB / CPU<1%),
> M002-AC-13 + AC-14 (REQ-020 latency P95), REQ-017 stability SLO
> (≥99% of 5-min windows zero MCP disconnect).

## Prerequisites

- macOS host with stable power + network (laptop on charger; sleep prevention
  via `caffeinate` or System Settings → Energy Saver → Prevent automatic sleeping
  on AC).
- `TELEGRAM_BOT_TOKEN` env var set (real bot, not a sandbox).
- Telegram client logged in as the admin user; bot already DM'd once (so
  AdminChatRegistry has captured the chat).
- Daemon installed via `/telegram-channels-pro:install-daemon` (launchd mode
  recommended — KeepAlive auto-restart is part of what we're testing).
- This repo checked out at the host's `~/advance-kit/advance-kit`.

## Execution

### 1. Start the soak monitor (passive sampler)

In a long-lived shell (tmux / screen recommended):

```bash
cd ~/advance-kit/advance-kit/plugins/telegram-channels-pro
SOAK_HOURS=72 \
SOAK_INTERVAL_SEC=60 \
SOAK_OUT_DIR=~/soak-logs \
caffeinate -dimsu ./bin/soak-monitor.sh
```

`caffeinate -dimsu` prevents display + idle sleep + system sleep + user idle
for the duration of the wrapped command — without it macOS will suspend the
daemon mid-soak and invalidate measurements.

This produces `~/soak-logs/samples-YYYYMMDD.jsonl` (one line per minute);
expect ~4320 lines over 72h.

### 2. Generate inbound traffic (active — only if you want to exercise REQ-018 zero-loss + REQ-020 latency)

In a separate session, periodically (e.g., once per hour) DM the bot with
short test messages and verify they reach a registered claude session. Record
roughly:

- DM sent timestamp (your watch / phone clock)
- claude session received timestamp (visible in claude transcript)

For latency P95 at the bar PRD §5 specifies (TG→claude < 5s P95;
reply→TG < 2s P95 delivered-only; approval < 3s P95 60s-click-window),
collect ≥30 timed pairs over the 72h window. Calculate P95 manually or via
spreadsheet.

This step is OPTIONAL for the soak monitor; without it you still get
M001-AC-15 + M001-AC-16 + REQ-017 closures, but M002-AC-13/14 + REQ-020
remain Partial.

### 3. After 72h: analyze

```bash
cd ~/advance-kit/advance-kit/plugins/telegram-channels-pro
bun run ./bin/soak-analyze.ts ~/soak-logs
```

Output verdict per AC:

```
=== REQ-019 / M001-AC-15: zero-zombie check ===
PASS: no bun processes with STAT=R AND etime>1h AND CPU>50% observed

=== REQ-021 / M001-AC-16: stationary RSS + CPU ===
Stationary samples: 4290 (excluded first 30min warm-up)
RSS P95: 38.2 MB (target: < 50 MB) PASS
CPU mean: 0.42% (target: < 1%) PASS

=== REQ-017: stability SLO (≥99% 5-min windows zero MCP disconnect) ===
Clean 5-min windows: 862/864 = 99.77%
SLO: PASS

=== Verdict ===
OVERALL: PASS
```

### 4. Update §3.4 ledgers + REQUIREMENTS_REGISTRY

If verdict is PASS, update:

- `docs/modules/MODULE-001-daemon-core.md` §3.4: M001-AC-15 + M001-AC-16
  → passed, Verified By Task = `soak-72h-YYYYMMDD`, Date = today.
- `docs/REQUIREMENTS_REGISTRY.md`: REQ-017 (Draft → Verified), REQ-019
  (Draft → Verified), REQ-021 (Partial → Verified).
- If you also collected latency pairs (step 2): MODULE-002 §3.4 AC-13 + AC-14
  → passed, REQ-020 Partial → Verified.

If verdict is FAIL:

- Inspect the failing dimension. Common causes:
  - RSS climb → memory leak somewhere. Capture `bun --inspect` heap snapshot.
  - CPU spike → poll loop pathology. Check daemon.err for repeated retries.
  - Disconnect windows → check session_disconnected events for clustered
    timestamps; correlate with claude crash / restart.
- Open a GitHub issue with the bundled `~/soak-logs/` + last 72h of
  `~/Library/Logs/advance-kit/telegram-channels-pro/daemon.{out,err}`.
- Do NOT mark ACs verified until a clean 72h re-run.

## What the harness does NOT cover

- **Active latency probe**: passive monitor records counts only, not
  per-message round-trip times. AC-13 + AC-14 require manual / scripted
  active traffic generation per step 2.
- **Crash autopsy**: if the daemon crashes mid-soak, launchd restarts it but
  the harness only counts disconnects, doesn't capture stack traces. Pair
  the soak with `console.app` filtered to "telegram-channels-pro" for
  crash-time diagnostics.
- **Cross-machine behavior**: REQ-027 macOS-only; soak is single-host.

## Time budget

A clean 72h soak with no failures = 3 days wall-clock. Plan for a 4-day
window to allow re-runs if the first attempt fails. Telegram bot rate
limits do NOT throttle passive observation; the daemon's getUpdates loop
runs at 25s long-poll intervals.
