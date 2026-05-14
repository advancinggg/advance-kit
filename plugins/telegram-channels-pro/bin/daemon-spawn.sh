#!/bin/bash
# daemon-spawn.sh — lazy-spawn entry point invoked by claude-side MCP proxy when
# the daemon socket connect fails (ECONNREFUSED).
#
# Forks the daemon as a detached child process via `nohup`. The daemon's normal
# boot sequence (M001) attempts to acquire the lock; if another daemon already
# wins the race, this one exits 0 with stderr "daemon already running, attaching".

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_BIN="${TGCP_DAEMON_BIN:-$PLUGIN_DIR/bin/daemon.ts}"
BUN_BIN="${TGCP_BUN_BIN:-$(command -v bun || echo /opt/homebrew/bin/bun)}"
LOG_DIR="${TGCP_HOME:-$HOME}/Library/Logs/advance-kit/telegram-channels-pro"

mkdir -p "$LOG_DIR"

if [ ! -x "$BUN_BIN" ] && ! command -v "$BUN_BIN" >/dev/null 2>&1; then
  echo "ERROR: bun binary not found at $BUN_BIN" >&2
  exit 1
fi
if [ ! -f "$DAEMON_BIN" ]; then
  echo "ERROR: daemon binary not found at $DAEMON_BIN" >&2
  exit 1
fi

# Fork the daemon detached; redirect stdout/stderr to log files.
nohup "$BUN_BIN" "$DAEMON_BIN" >>"$LOG_DIR/daemon.out" 2>>"$LOG_DIR/daemon.err" &
DAEMON_PID=$!
disown 2>/dev/null || true

# Brief wait so the daemon has a chance to acquire the lock OR detect a winner.
sleep 0.5

# Check if it's still running
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "daemon spawned (pid $DAEMON_PID)" >&2
  exit 0
else
  # Daemon exited quickly — either lock-loser ("attaching") or boot failure.
  echo "daemon already running, attaching (pid $DAEMON_PID exited; another daemon holds the lock)" >&2
  exit 0
fi
