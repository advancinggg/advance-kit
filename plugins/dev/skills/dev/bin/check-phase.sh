#!/usr/bin/env bash
# check-phase.sh — PreToolUse hook for /dev skill
# Enforces phase-based file access control
#
# Threat model: prevent the main agent from accidentally writing during locked phases.
# NOT designed to stop a determined adversary crafting arbitrary shell escapes.

set -euo pipefail

INPUT=$(cat)

# ── Prerequisites (fail-close) ──
for dep in jq python3; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    printf '{"permissionDecision":"deny","message":"[dev] %s is required but not found."}' "$dep"
    exit 0
  fi
done

# ── Locate & parse state ──
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "${CLAUDE_PLUGIN_DATA}/state.json" ]; then
  STATE_FILE="${CLAUDE_PLUGIN_DATA}/state.json"
else
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  STATE_FILE="${REPO_ROOT}/.dev-state/state.json"
fi

[ ! -f "$STATE_FILE" ] && { echo '{}'; exit 0; }

PHASE=$(jq -r '.phase' "$STATE_FILE" 2>/dev/null) || PHASE=""
REPO_ROOT_STATE=$(jq -r '.repo_root // ""' "$STATE_FILE" 2>/dev/null) || REPO_ROOT_STATE=""

if [ -z "$PHASE" ] || [ "$PHASE" = "null" ]; then
  printf '{"permissionDecision":"deny","message":"[dev] state.json corrupt. Run /dev doctor."}'; exit 0
fi

case "$PHASE" in
  plan|docs|implement|audit|test|adversarial|summary) ;;
  *) printf '{"permissionDecision":"deny","message":"[dev] Unknown phase: %s. Run /dev doctor."}' "$PHASE"; exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

# Helper: resolve path with symlinks
resolve() { python3 -c "import os; print(os.path.realpath('$1'))" 2>/dev/null || echo "$1"; }

# ============================================================
# Write/Edit rules
# ============================================================
if [ -n "$FILE_PATH" ]; then
  RESOLVE_BASE="${REPO_ROOT_STATE:-$(pwd)}"
  case "$FILE_PATH" in
    /*) ABS_PATH="$FILE_PATH" ;;
    ~/*) ABS_PATH="$HOME/${FILE_PATH#\~/}" ;;
    *) ABS_PATH="$RESOLVE_BASE/$FILE_PATH" ;;
  esac
  ABS_PATH=$(resolve "$ABS_PATH")
  REPO_REAL=$(resolve "$RESOLVE_BASE")

  case "$PHASE" in
    plan)
      PLANS_DIR=$(python3 -c "import os; print(os.path.realpath(os.path.expanduser('~/.claude/plans')))")
      STATE_REAL=$(resolve "$STATE_FILE")
      case "$ABS_PATH" in
        "$STATE_REAL") echo '{}'; exit 0 ;;
        "$PLANS_DIR"/*) echo '{}'; exit 0 ;;
        *) printf '{"permissionDecision":"deny","message":"[dev] Writes are not allowed during the PLAN phase."}'; exit 0 ;;
      esac ;;
    docs|summary)
      # docs: only allowlist docs + state; summary: only MODULE docs + ARCHITECTURE + state
      STATE_REAL=$(resolve "$STATE_FILE")
      [ "$ABS_PATH" = "$STATE_REAL" ] && { echo '{}'; exit 0; }
      ALLOWLIST=$(jq -r '.docs_allowlist[]? // empty' "$STATE_FILE" 2>/dev/null || true)
      if [ -n "$ALLOWLIST" ]; then
        while IFS= read -r allowed; do
          # Validate: must look like a doc path (.md or under docs/)
          case "$allowed" in
            *.md|docs/*) ;;
            *) continue ;;
          esac
          case "$allowed" in /*) ALLOWED_ABS="$allowed" ;; *) ALLOWED_ABS="$RESOLVE_BASE/$allowed" ;; esac
          ALLOWED_REAL=$(resolve "$ALLOWED_ABS")
          # Validate: resolved path must be inside repo root
          case "$ALLOWED_REAL" in
            "$REPO_REAL"/*) ;;
            *) continue ;;  # Skip: resolves outside repo (.. escape or absolute path)
          esac
          [ "$ABS_PATH" = "$ALLOWED_REAL" ] && { echo '{}'; exit 0; }
        done <<< "$ALLOWLIST"
      fi
      if [ "$PHASE" = "summary" ]; then
        # summary can also write ARCHITECTURE.md and docs/modules/* even if not in allowlist
        case "$ABS_PATH" in
          "$REPO_REAL"/ARCHITECTURE.md|"$REPO_REAL"/docs/modules/*) echo '{}'; exit 0 ;;
        esac
      fi
      printf '{"permissionDecision":"deny","message":"[dev] During the %s phase only documentation files may be modified."}' "$PHASE"; exit 0 ;;
    implement|audit|test|adversarial)
      # Allow writes only inside repo (realpath resolves symlinks)
      case "$ABS_PATH" in
        "$REPO_REAL"/*|"$REPO_REAL") echo '{}'; exit 0 ;;
        *) printf '{"permissionDecision":"ask","message":"[dev] Write path is outside the repo: %s"}' "$(echo "$ABS_PATH" | head -c 80)"; exit 0 ;;
      esac ;;
  esac
  echo '{}'; exit 0
fi

# ============================================================
# Bash rules
# ============================================================
if [ -n "$COMMAND" ]; then

  # ── Global: dangerous commands blocked in ALL phases ──
  # rm with both -r and -f (any order, any prefix flags)
  if echo "$COMMAND" | grep -qE '\brm\b' && echo "$COMMAND" | grep -qE '\-[a-z]*r' && echo "$COMMAND" | grep -qE '\-[a-z]*f'; then
    printf '{"permissionDecision":"deny","message":"[dev] Dangerous command blocked: %s"}' "$(echo "$COMMAND" | head -c 80)"; exit 0
  fi
  # git push with force (handles: git push -f, git push --force, git -c ... push --force, etc.)
  if echo "$COMMAND" | grep -qE '\bgit\b.*\bpush\b' && echo "$COMMAND" | grep -qE '(\s--force\b|\s-f\b|\s--force-with-lease\b)'; then
    printf '{"permissionDecision":"deny","message":"[dev] Dangerous command blocked: %s"}' "$(echo "$COMMAND" | head -c 80)"; exit 0
  fi
  # git reset --hard
  if echo "$COMMAND" | grep -qE '\bgit\b.*\breset\b.*--hard'; then
    printf '{"permissionDecision":"deny","message":"[dev] Dangerous command blocked: %s"}' "$(echo "$COMMAND" | head -c 80)"; exit 0
  fi
  # SQL destructive
  if echo "$COMMAND" | grep -qiE '(DROP\s+TABLE|TRUNCATE)'; then
    printf '{"permissionDecision":"deny","message":"[dev] Dangerous command blocked: %s"}' "$(echo "$COMMAND" | head -c 80)"; exit 0
  fi

  # ── Open phases ──
  if [ "$PHASE" = "implement" ] || [ "$PHASE" = "test" ] || [ "$PHASE" = "audit" ] || [ "$PHASE" = "adversarial" ]; then
    echo '{}'; exit 0
  fi

  # ── Summary: read-only Bash (same as plan/docs, only doc writes via Edit/Write) ──
  # Falls through to the locked-phase logic below

  # ══════════════════════════════════════════════════════════════
  # Locked phases: plan, docs, summary — strict read-only Bash
  # ══════════════════════════════════════════════════════════════

  # ── codex: use python3 for proper quote-aware parsing ──
  FIRST_CMD=$(echo "$COMMAND" | python3 -c "
import sys, shlex
cmd = sys.stdin.read().strip()
try:
    # Get first token, ignoring quotes
    first = cmd.split()[0].split('/')[-1] if cmd.split() else ''
    print(first)
except:
    print('')
" 2>/dev/null)

  if [ "$FIRST_CMD" = "codex" ]; then
    # Use python3 with shlex for proper quote-aware analysis
    CODEX_CHECK=$(echo "$COMMAND" | python3 -c '
import sys, shlex

cmd = sys.stdin.read().strip()

# Find first unquoted pipe to split codex segment from pipeline rest
in_sq = in_dq = False
esc = False
pipe_pos = -1
for i, c in enumerate(cmd):
    if esc: esc = False; continue
    if c == "\\" and in_dq: esc = True; continue
    if c == chr(39) and not in_dq: in_sq = not in_sq  # single quote
    elif c == chr(34) and not in_sq: in_dq = not in_dq  # double quote
    elif c == "|" and not in_sq and not in_dq: pipe_pos = i; break

codex_part = cmd[:pipe_pos] if pipe_pos >= 0 else cmd
rest = cmd[pipe_pos+1:] if pipe_pos >= 0 else ""

# Check for ; && || anywhere outside quotes (in the FULL command)
in_sq = in_dq = esc = False
for i, c in enumerate(cmd):
    if esc: esc = False; continue
    if c == "\\" and in_dq: esc = True; continue
    if c == chr(39) and not in_dq: in_sq = not in_sq
    elif c == chr(34) and not in_sq: in_dq = not in_dq
    elif not in_sq and not in_dq:
        if c == ";": print("deny:compound_operator"); sys.exit(0)
        if c == "&" and i+1 < len(cmd) and cmd[i+1] == "&": print("deny:compound_operator"); sys.exit(0)

# Extract -s value from codex segment (proper shlex parse)
try:
    tokens = shlex.split(codex_part)
except ValueError:
    print("deny:parse_error"); sys.exit(0)

sandbox = None
for j, t in enumerate(tokens):
    if t == "-s" and j+1 < len(tokens):
        sandbox = tokens[j+1]

if sandbox != "read-only":
    print(f"deny:sandbox:{sandbox}"); sys.exit(0)

# Check pipe segments after codex
# Only allow pure data-processing commands (no Turing-complete interpreters)
# The official template uses jq for JSON parsing — no python3/awk/sed needed
SAFE_PIPE = {"jq", "grep", "head", "tail", "cat", "wc", "sort", "tr", "cut"}
if rest.strip():
    segments = []
    current = []
    in_sq = in_dq = False
    for c in rest:
        if c == chr(39) and not in_dq: in_sq = not in_sq
        elif c == chr(34) and not in_sq: in_dq = not in_dq
        elif c == "|" and not in_sq and not in_dq:
            segments.append("".join(current).strip())
            current = []
            continue
        current.append(c)
    if current:
        segments.append("".join(current).strip())

    for seg in segments:
        if not seg: continue
        first_tok = seg.split()[0].split("/")[-1] if seg.split() else ""
        if first_tok not in SAFE_PIPE:
            print(f"deny:pipe_cmd:{first_tok}"); sys.exit(0)

# Check: no redirects to real files outside quotes
in_sq = in_dq = esc = False
i = 0
while i < len(cmd):
    c = cmd[i]
    if esc: esc = False; i += 1; continue
    if c == "\\" and in_dq: esc = True; i += 1; continue
    if c == chr(39) and not in_dq: in_sq = not in_sq
    elif c == chr(34) and not in_sq: in_dq = not in_dq
    elif not in_sq and not in_dq:
        # Check for redirect: [0-9]> or >> pointing to non-/dev/null
        if c == ">" and (i == 0 or cmd[i-1] in " \t0123456789&"):
            target_start = i + 1
            if target_start < len(cmd) and cmd[target_start] == ">": target_start += 1  # >>
            target = cmd[target_start:].lstrip().split()[0] if cmd[target_start:].strip() else ""
            if target and target not in ("/dev/null", "&1", "&2"):
                print(f"deny:redirect:{target}"); sys.exit(0)
    i += 1

print("allow")
' 2>/dev/null) || CODEX_CHECK="deny:python_error"

    case "$CODEX_CHECK" in
      allow) echo '{}'; exit 0 ;;
      deny:sandbox:*)
        printf '{"permissionDecision":"deny","message":"[dev] In the %s phase codex must run with -s read-only (detected: %s)"}' "$PHASE" "${CODEX_CHECK#deny:sandbox:}"; exit 0 ;;
      *)
        printf '{"permissionDecision":"deny","message":"[dev] In the %s phase this codex command was blocked: %s"}' "$PHASE" "${CODEX_CHECK#deny:}"; exit 0 ;;
    esac
  fi

  # ── Non-codex commands: strip quotes then scan ──
  UNQUOTED=$(echo "$COMMAND" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

  # Write pattern detection on unquoted command
  if echo "$UNQUOTED" | grep -qE '(sed\s+-i|perl\s+-i)'; then
    printf '{"permissionDecision":"deny","message":"[dev] In-place edits are not allowed during the %s phase"}' "$PHASE"; exit 0
  fi
  if echo "$UNQUOTED" | grep -qE '\btee\b'; then
    printf '{"permissionDecision":"deny","message":"[dev] tee is not allowed during the %s phase"}' "$PHASE"; exit 0
  fi
  if echo "$UNQUOTED" | grep -oE '[0-9]*>{1,2}[^ ]*' | grep -vE '>/dev/null|>&1|>&2' | grep -qE '.'; then
    printf '{"permissionDecision":"deny","message":"[dev] File redirection is not allowed during the %s phase"}' "$PHASE"; exit 0
  fi
  if echo "$UNQUOTED" | grep -qE '\-\-output[= ]'; then
    printf '{"permissionDecision":"deny","message":"[dev] --output is not allowed during the %s phase"}' "$PHASE"; exit 0
  fi

  # Scan all segments
  SEGMENTS=$(echo "$UNQUOTED" | sed 's/[|;&]\{1,2\}/\n/g')
  READ_CMDS="pwd ls find rg grep cat head tail wc diff less more file stat du tree jq yq sort uniq tr cut paste comm join which echo printf date env hostname uname id whoami"

  while IFS= read -r segment; do
    segment=$(echo "$segment" | sed 's/^[[:space:]]*//')
    [ -z "$segment" ] && continue
    seg_cmd=$(echo "$segment" | awk '{print $1}' | sed 's|.*/||')
    [ -z "$seg_cmd" ] && continue

    SEG_OK=false
    for rcmd in $READ_CMDS; do
      [ "$seg_cmd" = "$rcmd" ] && { SEG_OK=true; break; }
    done
    $SEG_OK && continue

    if [ "$seg_cmd" = "git" ]; then
      git_sub=$(echo "$segment" | awk '{print $2}')
      GIT_READ="status log diff show branch remote rev-parse describe tag ls-files ls-tree blame shortlog reflog symbolic-ref name-rev rev-list cat-file"
      GIT_OK=false
      for gs in $GIT_READ; do [ "$git_sub" = "$gs" ] && { GIT_OK=true; break; }; done
      $GIT_OK && continue
      printf '{"permissionDecision":"ask","message":"[dev] In the %s phase, git %s is not read-only"}' "$PHASE" "$git_sub"; exit 0
    fi

    printf '{"permissionDecision":"ask","message":"[dev] In the %s phase, %s is not in the read-only allowlist"}' "$PHASE" "$seg_cmd"; exit 0
  done <<< "$SEGMENTS"

  echo '{}'; exit 0
fi

echo '{}'
