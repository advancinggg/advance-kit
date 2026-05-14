#!/bin/bash
# launchctl-helper.sh — install / uninstall the telegram-channels-pro launchd plist.
#
# Test isolation env overrides:
#   LAUNCHCTL_BIN          — path to launchctl (mock for tests; default /bin/launchctl)
#   TGCP_HOME              — override $HOME (test isolation; default $HOME)
#   TGCP_PLIST_LABEL       — plist Label override (default com.advance.telegram-channels-pro)
#   TGCP_DISABLE_LAUNCHD_INSTALL=1 — force opt-out
#   TGCP_NON_INTERACTIVE   — skip prompts; use --default-yes / --default-no
#   TGCP_DEFAULT_YES       — when non-interactive, prompts default to "y"
#   TGCP_DEFAULT_NO        — when non-interactive, prompts default to "n"

set -u

SUBCMD="${1:-}"
LAUNCHCTL="${LAUNCHCTL_BIN:-/bin/launchctl}"
HOME_DIR="${TGCP_HOME:-${HOME:-/tmp}}"
LABEL="${TGCP_PLIST_LABEL:-com.advance.telegram-channels-pro}"
PLIST_PATH="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME_DIR/Library/Logs/advance-kit/telegram-channels-pro"
STATE_DIR="$HOME_DIR/Library/Application Support/advance-kit/telegram-channels-pro"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$PLUGIN_DIR/templates/${LABEL}.plist.tmpl"
DAEMON_BIN="${TGCP_DAEMON_BIN:-$PLUGIN_DIR/bin/daemon.ts}"
BUN_BIN="${TGCP_BUN_BIN:-$(command -v bun || echo /opt/homebrew/bin/bun)}"

log_info() { echo "$@"; }
log_err()  { echo "$@" >&2; }

require_macos() {
  local uname_s
  uname_s="$(uname -s)"
  if [ "$uname_s" != "Darwin" ]; then
    log_err "ERROR: telegram-channels-pro install supported on macOS only (detected: $uname_s)."
    log_err "Linux systemd / Windows Service support is on the v0.3+ roadmap."
    return 1
  fi
}

prompt_yn() {
  # $1: prompt text; $2: default ("y" or "n")
  local prompt="$1"
  local default="$2"
  if [ "${TGCP_NON_INTERACTIVE:-}" = "1" ]; then
    if [ "${TGCP_DEFAULT_YES:-}" = "1" ]; then echo "y"; return; fi
    if [ "${TGCP_DEFAULT_NO:-}" = "1" ]; then echo "n"; return; fi
    echo "$default"
    return
  fi
  local hint
  if [ "$default" = "y" ]; then hint="(Y/n)"; else hint="(y/N)"; fi
  printf "%s %s: " "$prompt" "$hint" >&2
  local ans
  read -r ans
  if [ -z "$ans" ]; then echo "$default"; return; fi
  case "$ans" in y|Y|yes|YES|Yes) echo "y" ;; *) echo "n" ;; esac
}

cmd_install() {
  require_macos || return 1
  local opt_in
  if [ "${TGCP_DISABLE_LAUNCHD_INSTALL:-}" = "1" ]; then
    opt_in="n"
  else
    opt_in="$(prompt_yn "Enable open-bot auto-start via launchd?" "y")"
  fi
  if [ "$opt_in" != "y" ]; then
    log_info "Lazy-spawn mode active. Daemon will be spawned on first \`claude --channels telegram\` invocation."
    return 0
  fi
  local tg_token="${TELEGRAM_BOT_TOKEN:-}"
  if [ -z "$tg_token" ]; then
    log_err "WARNING: TELEGRAM_BOT_TOKEN env not set. Plist will be installed but the daemon will exit on boot until you run \`launchctl setenv TELEGRAM_BOT_TOKEN ...\` and reload."
  fi
  if [ ! -f "$TEMPLATE" ]; then
    log_err "ERROR: plist template not found at $TEMPLATE"
    return 1
  fi
  mkdir -p "$(dirname "$PLIST_PATH")"
  mkdir -p "$LOG_DIR"
  # Render template
  sed \
    -e "s|{{LABEL}}|$LABEL|g" \
    -e "s|{{BUN_BIN}}|$BUN_BIN|g" \
    -e "s|{{DAEMON_BIN}}|$DAEMON_BIN|g" \
    -e "s|{{LOG_DIR}}|$LOG_DIR|g" \
    -e "s|{{TG_TOKEN}}|$tg_token|g" \
    -e "s|{{HOME_DIR}}|$HOME_DIR|g" \
    "$TEMPLATE" > "$PLIST_PATH"
  chmod 0644 "$PLIST_PATH"
  if "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
    log_info "Daemon enabled. To uninstall: \`/telegram-channels-pro:uninstall-daemon\`"
    return 0
  else
    local rc=$?
    log_err "ERROR: launchctl bootstrap failed (exit $rc). This often means SIP / permission denial."
    log_err "Manual recovery:"
    log_err "  1. Inspect $PLIST_PATH (already installed)."
    log_err "  2. Try \`launchctl bootstrap gui/\$(id -u) $PLIST_PATH\` manually."
    log_err "  3. Or use lazy-spawn mode: invoke \`claude --channels telegram\` to spawn the daemon on demand."
    # Plugin install does NOT fail (AC-03 invariant)
    return 0
  fi
}

cmd_uninstall() {
  require_macos || return 1
  if [ -f "$PLIST_PATH" ]; then
    "$LAUNCHCTL" bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    log_info "Plist unloaded and removed: $PLIST_PATH"
  else
    log_info "No plist installed at $PLIST_PATH (already absent)."
  fi
  local remove_state
  remove_state="$(prompt_yn "Also remove state directory ($STATE_DIR)?" "n")"
  if [ "$remove_state" = "y" ]; then
    rm -rf "$STATE_DIR"
    log_info "State directory removed: $STATE_DIR"
  else
    log_info "State directory preserved (admin allowlist + offset.json + attachments retained)."
  fi
  log_info "Daemon uninstalled. If any orphan \`bun\` processes remain from prior unclean exits, run \`pkill -9 bun\` to clean up."
  return 0
}

case "$SUBCMD" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  *)
    log_err "usage: $0 {install|uninstall}"
    exit 2
    ;;
esac
