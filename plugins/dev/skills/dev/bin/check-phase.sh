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
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[dev] %s is required but not found."}}' "$dep"
    exit 0
  fi
done

# ── JSON-safe decision emitters (jq guaranteed present past the dep-check above) ──
#    Build every decision via `jq --arg` so untrusted text (commands, paths, phase)
#    is escaped — a raw value containing " or \ must never break the fail-closed JSON,
#    which would drop the decision and fail the gate open.
#    SHAPE CONTRACT (3.9.0): PreToolUse decisions MUST live under
#    hookSpecificOutput.permissionDecision — Claude Code's hook parser strips unknown
#    TOP-LEVEL keys (a bare top-level {"permissionDecision":...} parses to {} and the
#    gate silently fails open). Do not "simplify" this back to a top-level key.
emit_deny() { jq -cn --arg m "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$m}}'; }
emit_ask()  { jq -cn --arg m "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$m}}'; }

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

# notebook_path: NotebookEdit mutations carry their target there, not in file_path
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null || true)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

# Helper: resolve path with symlinks
resolve() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null || echo "$1"; }
# Helper: absolute+realpath form of a tool_input path (relative paths anchor to repo_root)
abs_of() {
  p="$1"; base="${REPO_ROOT_STATE:-$(pwd)}"
  case "$p" in
    /*) ;;
    ~/*) p="$HOME/${p#\~/}" ;;
    *) p="$base/$p" ;;
  esac
  resolve "$p"
}

# Corrupt/unknown state fails closed EXCEPT for repairs of the state file itself:
# /dev doctor must be able to rewrite state.json, otherwise a corrupt state deadlocks
# the session (the deny message points at a doctor whose own fix would be denied).
if [ -z "$PHASE" ] || [ "$PHASE" = "null" ]; then
  if [ -n "$FILE_PATH" ] && [ "$(abs_of "$FILE_PATH")" = "$(resolve "$STATE_FILE")" ]; then echo '{}'; exit 0; fi
  emit_deny "[dev] state.json corrupt. Run /dev doctor (writes to state.json itself are allowed for repair)."; exit 0
fi

case "$PHASE" in
  plan|docs|implement|audit|test|adversarial|summary) ;;
  *)
    if [ -n "$FILE_PATH" ] && [ "$(abs_of "$FILE_PATH")" = "$(resolve "$STATE_FILE")" ]; then echo '{}'; exit 0; fi
    emit_deny "[dev] Unknown phase: $PHASE. Run /dev doctor (writes to state.json itself are allowed for repair)."; exit 0 ;;
esac

# ============================================================
# Write/Edit rules
# ============================================================
if [ -n "$FILE_PATH" ]; then
  RESOLVE_BASE="${REPO_ROOT_STATE:-$(pwd)}"
  ABS_PATH=$(abs_of "$FILE_PATH")
  REPO_REAL=$(resolve "$RESOLVE_BASE")

  case "$PHASE" in
    plan)
      PLANS_DIR=$(python3 -c "import os; print(os.path.realpath(os.path.expanduser('~/.claude/plans')))")
      STATE_REAL=$(resolve "$STATE_FILE")
      case "$ABS_PATH" in
        "$STATE_REAL") echo '{}'; exit 0 ;;
        "$PLANS_DIR"/*) echo '{}'; exit 0 ;;
        *) emit_deny "[dev] Writes are not allowed during the PLAN phase."; exit 0 ;;
      esac ;;
    docs|summary)
      # docs: only allowlist docs + state; summary: only MODULE docs + ARCHITECTURE + state
      STATE_REAL=$(resolve "$STATE_FILE")
      if [ "$ABS_PATH" = "$STATE_REAL" ]; then
        # ── 3.8.0 (detection upgraded 3.9.0): DOCS-exit ledger-parity gate ────
        # When the agent writes state.json so that `phase` flips OUT of docs, assert
        # §1.5 ⊆ §3.4 for the touched modules BEFORE letting the run leave DOCS —
        # the mechanical backstop for the 3.7.0 "DOCS births §3.4 rows" invariant.
        # Detection is SEMANTIC, not a payload grep: reconstruct the post-edit
        # content (Write → tool_input.content; Edit → apply old_string→new_string to
        # the current file) and read the resulting `phase` field. A payload grep
        # misses the minimal legitimate Edit (old_string "docs" → "implement" never
        # contains the '"phase":' key). Frozen trigger semantics unchanged: fires
        # solely when the write's new content sets phase to a non-docs value.
        # CORRECTNESS gate (not security): ledger-parity-check.sh fails OPEN on any
        # ambiguity, so a parse hiccup never hard-blocks /dev; it denies ONLY on a
        # confirmed desync (a §1.5 AC with no §3.4 row).
        if [ "$PHASE" = "docs" ]; then
          FLIP=$(echo "$INPUT" | python3 -c '
import json, re, sys
try:
    inp = json.load(sys.stdin)
except Exception:
    print("no"); raise SystemExit
ti = inp.get("tool_input") or {}
if "content" in ti:                      # Write: full new content
    post = ti.get("content") or ""
else:                                    # Edit: apply the replacement to the current file
    try:
        cur = open(sys.argv[1]).read()
    except Exception:
        print("no"); raise SystemExit
    old, new = ti.get("old_string") or "", ti.get("new_string") or ""
    if not old or old not in cur:
        print("no"); raise SystemExit    # indeterminate reconstruction -> not a flip (fail-open)
    post = cur.replace(old, new) if ti.get("replace_all") else cur.replace(old, new, 1)
try:
    phase = (json.loads(post) or {}).get("phase")
except Exception:
    m = re.search(r"\"phase\"\s*:\s*\"([a-z]+)\"", post)
    phase = m.group(1) if m else None
print("yes" if (isinstance(phase, str) and phase != "docs") else "no")
' "$STATE_FILE" 2>/dev/null) || FLIP="no"
          if [ "$FLIP" = "yes" ]; then
            PARITY_SCRIPT="$(dirname "${BASH_SOURCE[0]}")/ledger-parity-check.sh"
            if [ -f "$PARITY_SCRIPT" ]; then
              set +e
              PARITY_OUT=$(bash "$PARITY_SCRIPT" "$STATE_FILE" "$REPO_REAL" 2>/dev/null)
              PARITY_RC=$?
              set -e
              if [ "$PARITY_RC" = "2" ]; then
                emit_deny "[dev] DOCS-exit blocked: §1.5 AC(s) have no §3.4 ledger row (ledger desync). Add the matching '| <AC-ID> | Y | untested | — | — |' rows before leaving DOCS — ${PARITY_OUT}"
                exit 0
              fi
            fi
          fi
        fi
        echo '{}'; exit 0
      fi
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
        # summary can also write its mandated bookkeeping targets even if not in
        # allowlist: ARCHITECTURE (both layouts — /spec generates docs/ARCHITECTURE.md),
        # the SYSTEM-ACCEPTANCE §2/§3 ledgers, the REQUIREMENTS_REGISTRY Status column,
        # and MODULE docs. Without docs/ paths here the plugin's own hook denies the
        # §6.1/§6.3 writes SUMMARY is required to make.
        case "$ABS_PATH" in
          "$REPO_REAL"/ARCHITECTURE.md|"$REPO_REAL"/docs/ARCHITECTURE.md|"$REPO_REAL"/docs/SYSTEM-ACCEPTANCE.md|"$REPO_REAL"/docs/REQUIREMENTS_REGISTRY.md|"$REPO_REAL"/docs/modules/*) echo '{}'; exit 0 ;;
        esac
      fi
      emit_deny "[dev] During the $PHASE phase only documentation files may be modified."; exit 0 ;;
    implement|audit|test|adversarial)
      # Allow writes only inside repo (realpath resolves symlinks)
      case "$ABS_PATH" in
        "$REPO_REAL"/*|"$REPO_REAL") echo '{}'; exit 0 ;;
        *) emit_ask "[dev] Write path is outside the repo: $(printf '%s' "$ABS_PATH" | head -c 80)"; exit 0 ;;
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
    emit_deny "[dev] Dangerous command blocked: $(printf '%s' "$COMMAND" | head -c 80)"; exit 0
  fi
  # git push with force (handles: git push -f, git push --force, git -c ... push --force, etc.)
  if echo "$COMMAND" | grep -qE '\bgit\b.*\bpush\b' && echo "$COMMAND" | grep -qE '(\s--force\b|\s-f\b|\s--force-with-lease\b)'; then
    emit_deny "[dev] Dangerous command blocked: $(printf '%s' "$COMMAND" | head -c 80)"; exit 0
  fi
  # git reset --hard
  if echo "$COMMAND" | grep -qE '\bgit\b.*\breset\b.*--hard'; then
    emit_deny "[dev] Dangerous command blocked: $(printf '%s' "$COMMAND" | head -c 80)"; exit 0
  fi
  # SQL destructive
  if echo "$COMMAND" | grep -qiE '(DROP\s+TABLE|TRUNCATE)'; then
    emit_deny "[dev] Dangerous command blocked: $(printf '%s' "$COMMAND" | head -c 80)"; exit 0
  fi

  # ── read-only dev version banner: side-effect-free by contract, allowed in ALL phases ──
  # (K1 / VERSIONING "version-drift visibility" checklist). The banner runs on /dev resume/status
  # into a locked phase, where bash/python3 are otherwise denied. The allowance is DELIBERATELY
  # narrow: a SINGLE-LINE, bare `bash <path>/bin/dev-version-banner.sh <spec|prd|dev> <N.N.N>` with
  # an optional `2>/dev/null` — nothing else. The path token may be double-quoted but must be ONE
  # shell word: the char set excludes space ' " ( ) ` ; & | < > and the first char cannot be `-`,
  # so a `bash -c '<payload>' .../dev-version-banner.sh` injection (where bash would run the -c
  # payload, not the banner) cannot pass, and no second command can ride along. Multi-line commands
  # are rejected outright (grep is line-oriented — a benign first line must not bless a malicious
  # second line). The label is pinned to the 3 real skills and the version to strict N.N.N. The
  # global dangerous-command guards above already ran.
  if [ "$(printf '%s' "$COMMAND" | tr -d '\n\r' | wc -c)" = "$(printf '%s' "$COMMAND" | wc -c)" ] \
     && printf '%s' "$COMMAND" | grep -qE '^[[:space:]]*bash[[:space:]]+"?[A-Za-z0-9_./{}:$~][A-Za-z0-9_./{}:$~-]*/bin/dev-version-banner\.sh"?[[:space:]]+(spec|prd|dev)[[:space:]]+v?[0-9]+\.[0-9]+\.[0-9]+([[:space:]]+2>/dev/null)?[[:space:]]*$'; then
    echo '{}'; exit 0
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

# Check for ; && || (outside quotes) and command substitution (outside SINGLE
# quotes — $(...)/backticks are live inside double quotes) in the FULL command.
# EXCEPTION: the canonical codex template uses -C "$(git rev-parse --show-toplevel)" as
# the ONE sanctioned substitution (that is how the PLAN/DOCS/SUMMARY-phase codex evaluator
# resolves the repo root). Blank it out before scanning so it is allowed while every
# OTHER substitution is still denied. Without this, the locked-phase dual-model review
# self-blocks. Any deviation from the exact literal falls through to deny (fail-safe).
# (No apostrophes in this comment: it lives inside the outer python3 -c single quotes.)
scan = cmd.replace("$(git rev-parse --show-toplevel)", " ")
in_sq = in_dq = esc = False
for i, c in enumerate(scan):
    if esc: esc = False; continue
    if c == "\\" and in_dq: esc = True; continue
    if c == chr(39) and not in_dq: in_sq = not in_sq
    elif c == chr(34) and not in_sq: in_dq = not in_dq
    elif not in_sq:
        if c == chr(96): print("deny:cmd_substitution"); sys.exit(0)  # backtick
        if c == "$" and i+1 < len(scan) and scan[i+1] == "(": print("deny:cmd_substitution"); sys.exit(0)
        if not in_dq:
            if c == ";": print("deny:compound_operator"); sys.exit(0)
            if c == "&" and i+1 < len(scan) and scan[i+1] == "&": print("deny:compound_operator"); sys.exit(0)

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
        emit_deny "[dev] In the $PHASE phase codex must run with -s read-only (detected: ${CODEX_CHECK#deny:sandbox:})"; exit 0 ;;
      *)
        emit_deny "[dev] In the $PHASE phase this codex command was blocked: ${CODEX_CHECK#deny:}"; exit 0 ;;
    esac
  fi

  # ── Command substitution is live even inside double quotes: strip only the inert
  #    single-quoted spans, then deny any $( or backtick — inner commands would evade
  #    the per-segment allowlist scan below (e.g. `echo "$(rm x)"`). Locked phases only.
  #    (A backslash-escaped literal like `grep "\$(x)"` is fail-safe over-denied here —
  #    acceptable for a rare read-only locked-phase command; the codex branch, which
  #    must permit the sanctioned `-C "$(git rev-parse --show-toplevel)"`, handles
  #    escapes precisely instead.)
  SQ_STRIPPED=$(printf '%s' "$COMMAND" | sed "s/'[^']*'//g")
  if printf '%s' "$SQ_STRIPPED" | grep -qE '\$\(|`'; then
    emit_deny "[dev] Command substitution is not allowed during the $PHASE phase"; exit 0
  fi

  # ── Non-codex commands: strip quotes then scan ──
  UNQUOTED=$(echo "$COMMAND" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

  # Write pattern detection on unquoted command
  if echo "$UNQUOTED" | grep -qE '(sed\s+-i|perl\s+-i)'; then
    emit_deny "[dev] In-place edits are not allowed during the $PHASE phase"; exit 0
  fi
  if echo "$UNQUOTED" | grep -qE '\btee\b'; then
    emit_deny "[dev] tee is not allowed during the $PHASE phase"; exit 0
  fi
  if echo "$UNQUOTED" | grep -oE '[0-9]*>{1,2}[^ ]*' | grep -vE '>/dev/null|>&1|>&2' | grep -qE '.'; then
    emit_deny "[dev] File redirection is not allowed during the $PHASE phase"; exit 0
  fi
  if echo "$UNQUOTED" | grep -qE '\-\-output[= ]'; then
    emit_deny "[dev] --output is not allowed during the $PHASE phase"; exit 0
  fi

  # Scan all segments
  SEGMENTS=$(echo "$UNQUOTED" | sed 's/[|;&]\{1,2\}/\n/g')
  READ_CMDS="pwd ls find rg grep cat head tail wc diff less more file stat du tree jq yq sort uniq tr cut paste comm join which echo printf date env hostname uname id whoami"

  while IFS= read -r segment; do
    segment=$(echo "$segment" | sed 's/^[[:space:]]*//')
    [ -z "$segment" ] && continue
    seg_cmd=$(echo "$segment" | awk '{print $1}' | sed 's|.*/||')
    [ -z "$seg_cmd" ] && continue

    # Write-capable flags of otherwise read-only allowlisted commands
    if [ "$seg_cmd" = "find" ] && printf '%s' "$segment" | grep -qE '(^|[[:space:]])-(delete|exec|execdir|ok|okdir|fls|fprint)'; then
      emit_deny "[dev] find with write/exec flags is not allowed during the $PHASE phase"; exit 0
    fi
    if [ "$seg_cmd" = "sort" ] && printf '%s' "$segment" | grep -qE '(^|[[:space:]])-o([[:space:]]|$)'; then
      emit_deny "[dev] sort -o is not allowed during the $PHASE phase"; exit 0
    fi
    if [ "$seg_cmd" = "yq" ] && printf '%s' "$segment" | grep -qE '(^|[[:space:]])(-i|--inplace)([[:space:]]|$|=)'; then
      emit_deny "[dev] yq in-place editing is not allowed during the $PHASE phase"; exit 0
    fi

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
      emit_ask "[dev] In the $PHASE phase, git $git_sub is not read-only"; exit 0
    fi

    emit_ask "[dev] In the $PHASE phase, $seg_cmd is not in the read-only allowlist"; exit 0
  done <<< "$SEGMENTS"

  echo '{}'; exit 0
fi

echo '{}'
