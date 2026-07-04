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

# ── Active-workflow guard (3.9.0) ──
# While a /dev, /spec, or /prd run is active, auto-sync stands down entirely:
# `git add -A` here would sweep unfinished mid-phase work into an auto commit,
# polluting the deterministic `git diff start_commit..HEAD` audit target (the
# exact reason /dev §3.1 bans `git add -A`) and pushing unconfirmed DOCS/IMPLEMENT
# edits before the user gates ran. Workflow commits are made explicitly by the
# skills themselves; auto-sync resumes when the state file is cleaned up.
REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PROJECT_DIR")
if [ -f "$REPO_TOP/.dev-state/state.json" ] \
   || [ -f "$REPO_TOP/docs/.spec-state/progress.json" ] \
   || [ -f "$REPO_TOP/docs/.prd-state/progress.json" ]; then
  echo "[$(date)] Active workflow state detected — auto-sync skipped in $PROJECT_DIR" >> "$LOG"
  exit 0
fi

# ── Gitleaks binary (resolved early: both push paths must scan) ──
GITLEAKS_BIN=""
if   [ -x "$HOME/.local/bin/gitleaks" ]; then GITLEAKS_BIN="$HOME/.local/bin/gitleaks"
elif command -v gitleaks >/dev/null 2>&1;   then GITLEAKS_BIN=$(command -v gitleaks)
fi

# ── Push remote derived from the branch's configured remote (falls back to origin) ──
# NB: parse `branch.<b>.remote`, NOT `${UPSTREAM%%/*}` — a LOCAL-branch upstream
# (`git branch --set-upstream-to=main`) sets branch.<b>.remote='.' and abbrev-ref
# returns a slashless name, so the %%/* form would yield a bogus remote ('main')
# and the [ -z ] fallback can never fire. A '.' (local) or empty remote → origin.
UPSTREAM=$(git rev-parse --abbrev-ref "@{u}" 2>/dev/null || echo "")
REMOTE=$(git config "branch.$BRANCH.remote" 2>/dev/null || echo "")
{ [ -z "$REMOTE" ] || [ "$REMOTE" = "." ]; } && REMOTE=origin

# ── Nothing to commit? ──
if git diff --quiet && git diff --cached --quiet \
    && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  # No new work to stage, but push any unpushed local commits (e.g., from
  # /dev or /spec inline commits that were created without a push).
  if [ -n "$UPSTREAM" ] && [ -n "$(git log "$UPSTREAM"..HEAD --oneline 2>/dev/null)" ]; then
    # Scan the OUTGOING COMMITS before pushing — commits created inline by a skill
    # were never staged through the scan below, so this path must scan too.
    # Scan `git log -p` of the range (every commit's patch), NOT `git diff A..HEAD`
    # (the two-dot endpoint diff hides a secret that a later unpushed commit removes
    # — the add-then-remove case — while the commit still carries it into pushed
    # history). Same fail-closed policy: rc=1 secrets and rc>=2 scanner failure both block.
    if [ -n "$GITLEAKS_BIN" ]; then
      GL_EXIT=0
      GL_OUT=$(git log -p "$UPSTREAM"..HEAD | "$GITLEAKS_BIN" detect --pipe --no-banner 2>&1) || GL_EXIT=$?
      if [ "$GL_EXIT" -ne 0 ]; then
        echo "[$(date)] GITLEAKS BLOCKED unpushed-commit push (rc=$GL_EXIT) in $PROJECT_DIR" >> "$LOG"
        echo "[$(date)] $GL_OUT" >> "$LOG"
        echo "gitleaks blocked the push of unpushed commits (rc=$GL_EXIT). See $LOG for details."
        exit 0
      fi
      echo "[$(date)] GITLEAKS PASS (outgoing commits) in $PROJECT_DIR" >> "$LOG"
    else
      echo "[$(date)] gitleaks not installed, skipping outgoing-commit scan in $PROJECT_DIR" >> "$LOG"
    fi
    echo "[$(date)] No new changes, but pushing unpushed commits in $PROJECT_DIR" >> "$LOG"
    if git push "$REMOTE" "$BRANCH" 2>>"$LOG"; then
      echo "[$(date)] Pushed to $REMOTE/$BRANCH" >> "$LOG"
    else
      echo "[$(date)] git push failed in $PROJECT_DIR" >> "$LOG"
    fi
  fi
  exit 0
fi

# ── Stage ──
git add -A || {
  echo "[$(date)] git add failed in $PROJECT_DIR" >> "$LOG"
  exit 0
}
git diff --cached --quiet && exit 0  # nothing staged after all

# ── Gitleaks scan (staged changes; binary resolved above) ──
if [ -n "$GITLEAKS_BIN" ]; then
  GL_EXIT=0
  GL_OUT=$(git diff --cached | "$GITLEAKS_BIN" detect --pipe --no-banner 2>&1) || GL_EXIT=$?
  if [ "$GL_EXIT" -eq 1 ]; then
    # rc=1: secrets detected → block (fail closed)
    echo "[$(date)] GITLEAKS BLOCKED push in $PROJECT_DIR" >> "$LOG"
    echo "[$(date)] $GL_OUT" >> "$LOG"
    echo "gitleaks detected secrets — push blocked. See $LOG for details."
    git reset HEAD --quiet || true
    exit 0
  elif [ "$GL_EXIT" -ne 0 ]; then
    # rc>=2: the scanner ITSELF failed (config/flag/runtime) — do NOT treat as pass.
    # Fail closed: skip commit+push so unscanned changes are never pushed.
    echo "[$(date)] GITLEAKS SCAN FAILED (rc=$GL_EXIT) in $PROJECT_DIR — commit/push skipped" >> "$LOG"
    echo "[$(date)] $GL_OUT" >> "$LOG"
    echo "gitleaks scan failed (rc=$GL_EXIT) — commit/push skipped (changes left staged). See $LOG."
    exit 0
  fi
  echo "[$(date)] GITLEAKS PASS in $PROJECT_DIR" >> "$LOG"
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

    # Safe empty-array expansion (bash 3.2 compat: ${arr[@]:+"${arr[@]}"} pattern)
    # NOTE: do NOT pass --bare. --bare skips user config loading, which means the
    # nested `claude` cannot resolve the OAuth token and exits rc=1 with
    # "Not logged in · Please run /login" (verified 2026-05-11). Without --bare,
    # `-p` resolves auth normally; recursion is prevented by CLAUDE_SKIP_AUTOSYNC=1
    # below (exported into the child env so its own stop.sh / git-auto-pull.sh
    # short-circuit). Cost: ~18s vs ~1s under --bare; still well under the 60s timeout.
    OUT=$(printf '%s' "$PROMPT" | \
      CLAUDE_SKIP_AUTOSYNC=1 ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} "$CLAUDE_BIN_RESOLVED" \
        -p \
        --strict-mcp-config \
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
        # Don't log the raw stdout content — it's diff-derived and could contain
        # sensitive prompt-injected bytes.
        echo "[$(date)] claude output rejected (no conventional-commit line in first 5)" >> "$LOG"
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
if git push "$REMOTE" "$BRANCH" 2>>"$LOG"; then
  echo "[$(date)] Pushed to $REMOTE/$BRANCH" >> "$LOG"
else
  echo "[$(date)] git push failed in $PROJECT_DIR" >> "$LOG"
fi
exit 0
