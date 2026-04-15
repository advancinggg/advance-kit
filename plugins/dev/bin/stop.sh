#!/usr/bin/env bash
# stop.sh — Consolidated Stop hook
# Flow: stage → gitleaks scan (block on hit) → generate commit message via
# `claude -p` (Scheme 1) → commit → push.
#
# Single serialized bash script: Claude Code runs commands in a `hooks`
# array in parallel, so prior 3-script design was racy. Consolidation
# guarantees ordering.
#
# Env overrides:
#   CLAUDE_SKIP_AUTOSYNC=1          — bail immediately (recursion guard / manual suspend)
#   CLAUDE_DEV_NO_AUTO_COMMIT_MSG=1 — skip LLM; use timestamp message
#   CLAUDE_BIN                      — path to claude CLI override

# ── Bash-version guard (macOS /bin/bash is 3.2; we need 4+ for empty-array expansion under set -u) ──
[ "${BASH_VERSINFO[0]:-0}" -ge 4 ] || exit 0

set -uo pipefail

cat > /dev/null  # drain hook JSON from stdin

# ── Recursion guard ──
[ "${CLAUDE_SKIP_AUTOSYNC:-0}" = "1" ] && exit 0

# ── Opt-out ──
SKIP_LLM=0
[ "${CLAUDE_DEV_NO_AUTO_COMMIT_MSG:-0}" = "1" ] && SKIP_LLM=1

# ── Paths ──
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/dev}"
LOG="$DATA_DIR/git-auto-sync.log"
mkdir -p "$DATA_DIR"

cd "$PROJECT_DIR" || exit 0

# ── Repo guards ──
git rev-parse --is-inside-work-tree &>/dev/null || exit 0
git remote | grep -q . || exit 0
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
[ -z "$BRANCH" ] && exit 0

# ── Nothing to commit? ──
if git diff --quiet && git diff --cached --quiet \
    && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

# ── Stage ──
git add -A || {
  echo "[$(date)] git add failed in $PROJECT_DIR" >> "$LOG"
  exit 0
}
git diff --cached --quiet && exit 0  # nothing staged after all

# ── Gitleaks scan ──
GITLEAKS_BIN=""
if   [ -x "$HOME/.local/bin/gitleaks" ]; then GITLEAKS_BIN="$HOME/.local/bin/gitleaks"
elif command -v gitleaks >/dev/null 2>&1;   then GITLEAKS_BIN=$(command -v gitleaks)
fi

if [ -n "$GITLEAKS_BIN" ]; then
  GL_EXIT=0
  GL_OUT=$(git diff --cached | "$GITLEAKS_BIN" detect --pipe --no-banner 2>&1) || GL_EXIT=$?
  if [ "$GL_EXIT" -eq 1 ]; then
    echo "[$(date)] GITLEAKS BLOCKED push in $PROJECT_DIR" >> "$LOG"
    echo "[$(date)] $GL_OUT" >> "$LOG"
    echo "gitleaks detected secrets — push blocked. See $LOG for details."
    git reset HEAD --quiet || true
    exit 0
  fi
  echo "[$(date)] GITLEAKS PASS in $PROJECT_DIR (rc=$GL_EXIT)" >> "$LOG"
else
  echo "[$(date)] gitleaks not installed, skipping scan in $PROJECT_DIR" >> "$LOG"
fi

# ── Generate commit message (Scheme 1) ──
MSG_LLM=""
if [ "$SKIP_LLM" = "0" ]; then
  CLAUDE_BIN_RESOLVED=""
  for c in \
      "${CLAUDE_BIN:-}" \
      "$HOME/.local/bin/claude" \
      "/opt/homebrew/bin/claude" \
      "/usr/local/bin/claude" \
      "$(command -v claude 2>/dev/null)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CLAUDE_BIN_RESOLVED="$c"; break; fi
  done

  if [ -n "$CLAUDE_BIN_RESOLVED" ]; then
    PROMPT_HEADER='You write Conventional Commits subject lines. Output EXACTLY one line in the form type(scope): summary (type is one of: feat, fix, chore, docs, refactor, test, style, perf, build, ci, revert). At most 72 chars. No trailing period. No markdown. No quotes. No explanation. Diff:'
    STAT=$(git diff --cached --stat 2>/dev/null || true)
    # SIGPIPE-safe truncation under pipefail
    BODY=$({ git diff --cached 2>/dev/null || true; } | head -c 20000 2>/dev/null || true)
    PROMPT="${PROMPT_HEADER}"$'\n\n'"${STAT}"$'\n'"${BODY}"

    # Build TIMEOUT_CMD array (empty when no wrapper available)
    TIMEOUT_CMD=()
    if   command -v timeout  >/dev/null 2>&1; then TIMEOUT_CMD=(timeout 60)
    elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD=(gtimeout 60)
    fi

    OUT=$(printf '%s' "$PROMPT" | \
      CLAUDE_SKIP_AUTOSYNC=1 "${TIMEOUT_CMD[@]}" "$CLAUDE_BIN_RESOLVED" \
        --bare -p \
        --model haiku \
        --output-format text \
        --permission-mode bypassPermissions \
        --tools "" \
        2>>"$LOG")
    RC=$?

    if [ "$RC" -ne 0 ]; then
      echo "[$(date)] claude -p rc=$RC in $PROJECT_DIR" >> "$LOG"
    else
      # Scan first 5 non-empty lines for a conventional-commit match
      CC_RE='^(feat|fix|chore|docs|refactor|test|style|perf|build|ci|revert)(\([^)]+\))?!?: .+'
      LINE_COUNT=0
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        LINE_COUNT=$((LINE_COUNT + 1))
        if [[ "$line" =~ $CC_RE ]]; then
          MSG_LLM=$(printf '%s' "$line" | cut -c 1-100)
          break
        fi
        [ "$LINE_COUNT" -ge 5 ] && break
      done <<< "$OUT"

      if [ -z "$MSG_LLM" ]; then
        echo "[$(date)] rejected non-conventional output: $(printf '%s' "$OUT" | head -c 80)" >> "$LOG"
      fi
    fi
  else
    echo "[$(date)] claude CLI not found, using timestamp fallback" >> "$LOG"
  fi
fi

# ── Fallback message ──
if [ -n "$MSG_LLM" ]; then
  MSG="$MSG_LLM"
else
  MSG="auto-sync: $(date '+%Y-%m-%d %H:%M:%S')"
fi

echo "[$(date)] DIR=$PROJECT_DIR MSG=$MSG" >> "$LOG"

# ── Commit ──
git commit -m "$MSG" || {
  echo "[$(date)] git commit failed in $PROJECT_DIR" >> "$LOG"
  exit 0
}

# ── Push ──
git push origin "$BRANCH" 2>>"$LOG" || {
  echo "[$(date)] git push failed in $PROJECT_DIR" >> "$LOG"
}

echo "[$(date)] Pushed to $BRANCH" >> "$LOG"
exit 0
