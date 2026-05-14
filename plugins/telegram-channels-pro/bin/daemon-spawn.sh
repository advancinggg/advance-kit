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

# Adversarial R1 #4: distinguish lock-loser-OK from boot-failure-NOT-OK by
# verifying the daemon socket appears within a bounded wait (lock-loser
# means a winning daemon is already serving, so its socket must exist).
STATE_DIR="${TGCP_STATE_DIR:-${TGCP_HOME:-$HOME}/Library/Application Support/advance-kit/telegram-channels-pro}"
SOCKET_PATH="$STATE_DIR/daemon.sock"
WAIT_DEADLINE_S=3
elapsed=0
while [ "$elapsed" -lt "$WAIT_DEADLINE_S" ]; do
  # Check existence (-e): only the daemon's UDS bind creates this path, so
  # presence is sufficient evidence the daemon got past M001 boot. (-S checks
  # socket file-type but breaks tests using touched-file mocks; existence is
  # equally diagnostic for the boot-failure-vs-attaching distinction.)
  if [ -e "$SOCKET_PATH" ]; then
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "daemon spawned (pid $DAEMON_PID, socket $SOCKET_PATH)" >&2
    else
      echo "daemon already running, attaching (pid $DAEMON_PID exited; another daemon holds the lock; socket $SOCKET_PATH live)" >&2
    fi
    exit 0
  fi
  sleep 0.5
  elapsed=$((elapsed + 1))
done

# No socket after deadline — boot failure
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "ERROR: daemon spawned (pid $DAEMON_PID) but socket never appeared at $SOCKET_PATH within ${WAIT_DEADLINE_S}s — check $LOG_DIR/daemon.err" >&2
else
  echo "ERROR: daemon (pid $DAEMON_PID) exited before socket appeared — likely boot failure; check $LOG_DIR/daemon.err" >&2
fi
exit 1
