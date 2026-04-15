#!/usr/bin/env bash
# git-auto-pull.sh — UserPromptSubmit hook
# Pulls latest changes with cooldown to avoid pulling on every prompt.
#
# Environment (provided by Claude Code):
#   CLAUDE_PROJECT_DIR — the project's working directory
#   CLAUDE_PLUGIN_DATA — plugin's persistent data directory
#
# Cooldown: 5 minutes between pulls (configurable via GIT_PULL_COOLDOWN_SECS)

set -euo pipefail

cat > /dev/null  # drain stdin (hook sends JSON)

# ── Recursion guard (defense-in-depth; --bare on nested `claude -p` already skips hooks) ──
[ "${CLAUDE_SKIP_AUTOSYNC:-0}" = "1" ] && exit 0

COOLDOWN="${GIT_PULL_COOLDOWN_SECS:-300}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

cd "$PROJECT_DIR"

# ── Guard: must be a git repo with a remote ──
git rev-parse --is-inside-work-tree &>/dev/null || exit 0
git remote | grep -q . || exit 0

# ── Guard: must be on a branch (not detached HEAD) ──
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null) || exit 0
[ -z "$BRANCH" ] && exit 0

# ── Guard: branch must have an upstream ──
git rev-parse --abbrev-ref "@{u}" &>/dev/null || exit 0

# ── Cooldown check ──
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/dev}"
mkdir -p "$DATA_DIR"
PROJ_HASH=$(printf '%s' "$PROJECT_DIR" | cksum | cut -d' ' -f1)
COOLDOWN_FILE="$DATA_DIR/last-pull-${PROJ_HASH}"

if [ -f "$COOLDOWN_FILE" ]; then
  LAST_PULL=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_PULL))
  [ "$ELAPSED" -lt "$COOLDOWN" ] && exit 0
fi

# ── Pull ──
git pull --rebase --autostash --quiet 2>/dev/null || true

# ── Record timestamp ──
date +%s > "$COOLDOWN_FILE"

exit 0
