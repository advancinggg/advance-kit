#!/usr/bin/env bash
# git-pre-sync-check.sh — Stop hook (phase 1)
# Stages all changes and runs gitleaks secret scan.
# Exit non-zero to block the subsequent commit hook.
#
# Environment:
#   CLAUDE_PROJECT_DIR — project working directory
#   CLAUDE_PLUGIN_DATA — plugin data directory (for logs)

set -euo pipefail

cat > /dev/null  # drain stdin

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/dev}"
LOG="$DATA_DIR/git-auto-sync.log"

cd "$PROJECT_DIR"

# Must be a git repo with a remote
git rev-parse --is-inside-work-tree &>/dev/null || exit 0
git remote | grep -q . || exit 0

# No changes → skip entire pipeline
git diff --quiet && git diff --cached --quiet && \
  [ -z "$(git ls-files --others --exclude-standard)" ] && exit 0

# Must be on a branch
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null)
[ -z "$BRANCH" ] && exit 0

# Stage all changes
git add -A

# Run gitleaks on staged changes (graceful degradation if not installed)
GITLEAKS_BIN=""
if [ -x "${HOME}/.local/bin/gitleaks" ]; then
  GITLEAKS_BIN="${HOME}/.local/bin/gitleaks"
elif command -v gitleaks &>/dev/null; then
  GITLEAKS_BIN=$(command -v gitleaks)
fi

mkdir -p "$DATA_DIR"

if [ -n "$GITLEAKS_BIN" ]; then
  GITLEAKS_EXIT=0
  GITLEAKS_OUTPUT=$(git diff --cached | "$GITLEAKS_BIN" detect --pipe --no-banner 2>&1) || GITLEAKS_EXIT=$?
  if [ "$GITLEAKS_EXIT" -eq 1 ]; then
    echo "[$(date)] GITLEAKS BLOCKED push in $(pwd)" >> "$LOG"
    echo "[$(date)] $GITLEAKS_OUTPUT" >> "$LOG"
    echo "gitleaks detected secrets -- push blocked. Check $LOG for details."
    git reset HEAD --quiet
    exit 1
  fi
  echo "[$(date)] GITLEAKS PASS in $(pwd)" >> "$LOG"
else
  echo "[$(date)] GITLEAKS not installed, skipping scan in $(pwd)" >> "$LOG"
fi

exit 0
