#!/bin/bash
# soak-monitor.sh — passive 72h soak monitor for telegram-channels-pro daemon.
#
# Samples every SOAK_INTERVAL_SEC (default 60s):
#   - All bun processes: pid, ppid, stat, etime, pcpu, rss, comm
#   - Daemon socket existence + size
#   - Control socket existence
#   - Inbound update count (parsed from JSONL daemon log)
#   - quarantine_enter / quarantine_exit count
#   - session_connected / session_disconnected count
#
# Output format: JSONL to ${SOAK_OUT_DIR}/samples-YYYYMMDD.jsonl (rotates daily).
#
# Usage:
#   ./soak-monitor.sh                              # 72h default, ~/soak-logs output
#   SOAK_HOURS=24 ./soak-monitor.sh                # shorter run for smoke
#   SOAK_INTERVAL_SEC=30 ./soak-monitor.sh         # higher resolution
#   SOAK_OUT_DIR=/tmp/soak ./soak-monitor.sh       # custom output

set -u

SOAK_HOURS="${SOAK_HOURS:-72}"
SOAK_INTERVAL_SEC="${SOAK_INTERVAL_SEC:-60}"
SOAK_OUT_DIR="${SOAK_OUT_DIR:-${HOME:-/tmp}/soak-logs}"
HOME_DIR="${TGCP_HOME:-${HOME:-/tmp}}"
STATE_DIR="${TGCP_STATE_DIR:-$HOME_DIR/Library/Application Support/advance-kit/telegram-channels-pro}"
LOG_DIR="${TGCP_LOG_DIR:-$HOME_DIR/Library/Logs/advance-kit/telegram-channels-pro}"

mkdir -p "$SOAK_OUT_DIR"

SOAK_DEADLINE=$(( $(date +%s) + SOAK_HOURS * 3600 ))
echo "soak-monitor: starting; deadline $(date -r "$SOAK_DEADLINE" 2>/dev/null || date -d "@$SOAK_DEADLINE" 2>/dev/null), interval=${SOAK_INTERVAL_SEC}s, out=$SOAK_OUT_DIR" >&2

count_lines() {
  # $1: file pattern; $2: jq filter
  local files
  files=$(ls "$LOG_DIR"/daemon-*.jsonl 2>/dev/null | head -7)
  [ -z "$files" ] && { echo 0; return; }
  # shellcheck disable=SC2086
  cat $files 2>/dev/null | grep -c "$1" 2>/dev/null || echo 0
}

while [ "$(date +%s)" -lt "$SOAK_DEADLINE" ]; do
  ts=$(date +%s)
  ts_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  daystamp=$(date +%Y%m%d)
  out_file="$SOAK_OUT_DIR/samples-$daystamp.jsonl"

  # Capture all bun processes
  bun_procs=$(ps -A -o pid=,ppid=,stat=,etime=,pcpu=,rss=,comm= 2>/dev/null | grep -E '\bbun$|/bun( |$)' || true)

  # Inbound + state-change event counts
  inbound_n=$(count_lines '"event_type":"inbound_update"')
  quarantine_n=$(count_lines '"event_type":"quarantine_enter"')
  recover_n=$(count_lines '"event_type":"quarantine_exit"')
  sess_conn_n=$(count_lines '"event_type":"session_connected"')
  sess_disc_n=$(count_lines '"event_type":"session_disconnected"')

  # Socket presence
  mcp_sock_exists="false"; ctl_sock_exists="false"
  [ -e "$STATE_DIR/daemon.sock" ] && mcp_sock_exists="true"
  [ -e "$STATE_DIR/daemon.ctl.sock" ] && ctl_sock_exists="true"

  # Build the sample as a single JSONL line (manual JSON construction to avoid jq dep)
  # bun_procs is multi-line — encode as JSON array of objects via inline awk
  bun_json="["
  if [ -n "$bun_procs" ]; then
    bun_json+=$(echo "$bun_procs" | awk 'BEGIN{first=1} {
      if (!first) printf ",";
      first=0;
      printf "{\"pid\":%s,\"ppid\":%s,\"stat\":\"%s\",\"etime\":\"%s\",\"pcpu\":%s,\"rss\":%s,\"comm\":\"%s\"}",
        $1, $2, $3, $4, $5, $6, $7
    }')
  fi
  bun_json+="]"

  printf '{"ts":%s,"ts_iso":"%s","bun_procs":%s,"mcp_sock":%s,"ctl_sock":%s,"counts":{"inbound":%s,"quarantine_enter":%s,"quarantine_exit":%s,"session_connected":%s,"session_disconnected":%s}}\n' \
    "$ts" "$ts_iso" "$bun_json" "$mcp_sock_exists" "$ctl_sock_exists" \
    "$inbound_n" "$quarantine_n" "$recover_n" "$sess_conn_n" "$sess_disc_n" \
    >> "$out_file"

  sleep "$SOAK_INTERVAL_SEC"
done

echo "soak-monitor: completed after ${SOAK_HOURS}h" >&2
