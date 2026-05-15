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
const respPromise = new Promise((resolve, reject) => {
  let buf = "";
  Bun.connect({
    unix: ctlSock,
    socket: {
      open(sock) {
        sock.write(JSON.stringify({ kind: "status_request" }) + "\n");
      },
      data(_sock, data) {
        buf += new TextDecoder().decode(data);
        const nl = buf.indexOf("\n");
        if (nl >= 0) resolve(buf.slice(0, nl));
      },
      close() {
        if (buf.length > 0) resolve(buf);
        else reject(new Error("socket closed before response"));
      },
      error(_sock, err) { reject(err); },
    },
  }).catch(reject);
  setTimeout(() => reject(new Error("status request timeout")), 5000);
});
let line;
try { line = await respPromise; }
catch (err) { console.error("status request failed:", err.message); process.exit(1); }
let resp;
try { resp = JSON.parse(line); } catch { console.error("malformed response:", line); process.exit(1); }
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
process.exit(0);
'
