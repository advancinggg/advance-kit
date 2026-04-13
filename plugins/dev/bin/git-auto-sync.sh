#!/usr/bin/env bash
# git-auto-sync.sh — Stop hook (phase 2)
# Commits staged changes and pushes to remote.
# Reads commit message from ~/.claude/commit-msg.txt (convention from CLAUDE.md).
#
# Environment:
#   CLAUDE_PROJECT_DIR — project working directory
#   CLAUDE_PLUGIN_DATA — plugin data directory (for logs)

set -euo pipefail

cat > /dev/null  # drain stdin

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
COMMIT_MSG_FILE="$HOME/.claude/commit-msg.txt"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/dev}"
LOG="$DATA_DIR/git-auto-sync.log"

cd "$PROJECT_DIR"

# Must be a git repo with a remote
git rev-parse --is-inside-work-tree &>/dev/null || exit 0
git remote | grep -q . || exit 0

# Must be on a branch
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null)
[ -z "$BRANCH" ] && exit 0

# Ensure changes are staged (pre-sync-check should have done this, but be safe)
git add -A

# No staged changes → skip
git diff --cached --quiet && exit 0

# Read commit message from file
COMMIT_MSG=""
if [ -f "$COMMIT_MSG_FILE" ]; then
  COMMIT_MSG=$(head -1 "$COMMIT_MSG_FILE" | cut -c 1-100)
  rm -f "$COMMIT_MSG_FILE"
fi

mkdir -p "$DATA_DIR"

# Skip if Claude said no-commit
if [ "$COMMIT_MSG" = "no-commit" ]; then
  echo "[$(date)] DIR=$(pwd) Skipped: no-commit" >> "$LOG"
  git reset HEAD --quiet
  exit 0
fi

# Fallback message
if [ -z "$COMMIT_MSG" ]; then
  COMMIT_MSG="auto-sync: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$(date)] Using fallback (no commit-msg.txt found)" >> "$LOG"
fi

echo "[$(date)] DIR=$(pwd) MSG=$COMMIT_MSG" >> "$LOG"

git commit -m "$COMMIT_MSG"
git push origin "$BRANCH" 2>/dev/null || true

echo "[$(date)] Pushed to $BRANCH" >> "$LOG"
