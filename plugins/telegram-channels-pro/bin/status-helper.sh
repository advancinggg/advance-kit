#!/bin/bash
# status-helper.sh — connect to daemon control socket, send status_request, format response.
set -u

HOME_DIR="${TGCP_HOME:-$HOME}"
STATE_DIR="${TGCP_STATE_DIR:-$HOME_DIR/Library/Application Support/advance-kit/telegram-channels-pro}"
CTL_SOCK="$STATE_DIR/daemon.ctl.sock"

if [ ! -S "$CTL_SOCK" ]; then
  echo "daemon not running (control socket not found at $CTL_SOCK)" >&2
  echo "Try \`/telegram-channels-pro:install-daemon\` or check launchd state with \`launchctl list | grep telegram-channels-pro\`." >&2
  exit 1
fi

# Use Bun for socket I/O so we can avoid nc compatibility issues on macOS.
# Pass CTL_SOCK via TGCP_CTL_SOCK env (NOT shell-interpolated into JS source) to
# avoid shell-quoted-JS injection from paths containing apostrophes or other
# specials (adversarial finding R1 #1).
BUN_BIN="${TGCP_BUN_BIN:-$(command -v bun || echo /opt/homebrew/bin/bun)}"
TGCP_CTL_SOCK="$CTL_SOCK" "$BUN_BIN" -e '
const ctlSock = process.env.TGCP_CTL_SOCK;
if (!ctlSock) { console.error("missing TGCP_CTL_SOCK env"); process.exit(1); }
const sock = await Bun.connect({ unix: ctlSock, socket: { data() {}, error() {} } });
sock.write(JSON.stringify({ kind: "status_request" }) + "\n");
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
const s = resp.result;
console.log("Daemon status");
console.log("  Uptime:                 " + s.uptime_seconds + "s");
console.log("  Deployment mode:        " + s.deployment_mode);
console.log("  Polling state:          " + s.polling_state);
console.log("  Last inbound:           " + (s.last_inbound_ts ? new Date(s.last_inbound_ts).toISOString() : "never"));
console.log("  Quarantine:             " + (s.quarantine_active ? "yes" : "no"));
console.log("  Registered sessions:    " + s.registered_sessions);
console.log("  Pending approvals:      " + s.pending_approvals.current + " / " + s.pending_approvals.max);
console.log("  Admin source:           " + s.admin_source);
'
