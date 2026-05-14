#!/bin/bash
# reset-admin-helper.sh — connect to daemon control socket, send reset_admin_request,
# format response. Per Slice 2 design (CCD-5b), NEVER kills the daemon — the
# in-process forceReopenForReset path handles re-open in both deployment modes.
set -u

HOME_DIR="${TGCP_HOME:-$HOME}"
STATE_DIR="${TGCP_STATE_DIR:-$HOME_DIR/Library/Application Support/advance-kit/telegram-channels-pro}"
CTL_SOCK="$STATE_DIR/daemon.ctl.sock"
LOG_DIR="$HOME_DIR/Library/Logs/advance-kit/telegram-channels-pro"

if [ ! -S "$CTL_SOCK" ]; then
  echo "daemon not running (control socket not found at $CTL_SOCK)" >&2
  echo "Start it with \`/telegram-channels-pro:install-daemon\` (launchd) or \`claude --channels telegram\` (lazy-spawn)." >&2
  exit 1
fi

# Pass paths via env (NOT shell-interpolated) per adversarial R1 #1 fix.
BUN_BIN="${TGCP_BUN_BIN:-$(command -v bun || echo /opt/homebrew/bin/bun)}"
TGCP_CTL_SOCK="$CTL_SOCK" TGCP_LOG_DIR="$LOG_DIR" "$BUN_BIN" -e '
const ctlSock = process.env.TGCP_CTL_SOCK;
const logDir = process.env.TGCP_LOG_DIR ?? "(unknown log dir)";
if (!ctlSock) { console.error("missing TGCP_CTL_SOCK env"); process.exit(1); }
const sock = await Bun.connect({ unix: ctlSock, socket: { data() {}, error() {} } });
sock.write(JSON.stringify({ kind: "reset_admin_request" }) + "\n");
const reader = new ReadableStream({
  start(controller) {
    sock.data = (s, data) => controller.enqueue(data);
    sock.close = () => controller.close();
  },
}).getReader();
let buf = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  if (buf.includes("\n")) break;
}
sock.end();
const line = buf.split("\n")[0];
let resp;
try { resp = JSON.parse(line); } catch { console.error("malformed response"); process.exit(1); }
if (!resp.ok) { console.error("daemon error:", resp.error); process.exit(1); }
const r = resp.result;
console.log("Admin state cleared (cleared=" + r.cleared + ", prior_admin_hash=" + (r.prior_admin_hash ?? "none") + ").");
console.log("Daemon (pid " + r.daemon_pid + ", mode=" + r.deployment_mode + ") continues running with a fresh registration window.");
if (r.deployment_mode === "launchd") {
  console.log("Code printed in launchd stderr log; check " + logDir + "/daemon.err.");
} else {
  console.log("Send any DM to the bot — it will reply with the registration code (also printed at " + logDir + "/daemon.err).");
}
'
