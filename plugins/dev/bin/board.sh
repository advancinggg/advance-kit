#!/usr/bin/env bash
# board.sh — read-only /dev board snapshot dashboard (2.9.0+)
#
# Aggregates three sections of repository state to stdout:
#   1. Module progress — docs/modules/MODULE-*.md §3.4 ledger via the
#      SKILL.md §6.1.1 formula (passed * 100 + active / 2) / active.
#   2. Worktree status — git worktree list × per-worktree
#      .dev-state/state.json overlay (task_id, phase, eval_round, updated_at).
#   3. Task branches — dev-task-* ahead/behind vs per-branch base + dirty
#      detection + stale (no worktree) flagging.
#
# Read-only contract: no .dev-state/state.json writes, no git mutating ops,
# no `git fetch`, no LLM/network calls. See SKILL.md §7 for the full
# specification.
#
# Bash 3.2 compatible (macOS default). No `declare -A`, no `${var,,}`,
# no `mapfile`.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "board.sh: not inside a git repository" >&2
  exit 1
}

# ──────────────────────────────────────────────────────────────
# Colour init (ANSI only when stdout is a TTY)
# ──────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD=""
  DIM=""
  GREEN=""
  YELLOW=""
  RED=""
  CYAN=""
  RESET=""
fi

# ──────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────

# Sanitise externally-sourced display strings — replace shell-metachars +
# control chars with `?` and emit a stderr warning. Same contract as
# worktree-helper.sh list_cmd. NEVER used for control-flow values that
# flow into git invocations — those use a reject-on-metachar pre-check
# instead (see _is_safe_ref).
_sanitize() {
  local val="$1"
  local source_label="${2:-(unknown)}"
  case "$val" in
    *'$'*|*'`'*|*';'*|*'|'*|*'&'*|*$'\n'*|*$'\r'*|*$'\t'*|*'<'*|*'>'*)
      echo "board.sh: WARNING — field for $source_label contains shell metacharacter; displayed as ?" >&2
      printf '?'
      return ;;
  esac
  printf '%s' "$val"
}

# Strict reject-on-metachar test for values flowing into git ref-spec
# parsing. Returns 0 if value is safe to pass to git rev-parse / rev-list,
# non-zero otherwise.
_is_safe_ref() {
  local val="$1"
  [ -n "$val" ] || return 1
  case "$val" in
    *'$'*|*'`'*|*';'*|*'|'*|*'&'*|*$'\n'*|*$'\r'*|*$'\t'*|*'<'*|*'>'*)
      return 1 ;;
  esac
  return 0
}

# Render path with $HOME → ~ shortening (display only; path is
# filesystem-trusted).
_short_path() {
  local p="$1"
  if [ -n "${HOME:-}" ] && [ "${p#$HOME}" != "$p" ]; then
    printf '~%s' "${p#$HOME}"
  else
    printf '%s' "$p"
  fi
}

# Read a state.json field with `null` → `—` normalisation. Falls back to
# `—` if jq fails or the file is invalid.
_jq_field() {
  local file="$1"
  local field="$2"
  local val
  val=$(jq -r ".${field} // \"—\"" "$file" 2>/dev/null || echo "—")
  [ "$val" = "null" ] && val="—"
  printf '%s' "$val"
}

# Walk git worktree list --porcelain and emit `<path>\t<branch>` rows.
# Detached HEAD worktrees emit `<path>\tdetached`. Branch is short name.
_worktree_rows() {
  git worktree list --porcelain 2>/dev/null | awk '
    /^worktree / { p=$2; next }
    /^branch / { b=$2; sub("refs/heads/", "", b); print p "\t" b; p=""; b=""; next }
    /^detached/ { print p "\tdetached"; p=""; next }
  '
}

# Look up the owning worktree path for a given branch name. Empty string if
# no worktree pairs to this branch.
_branch_to_worktree() {
  local target="$1"
  _worktree_rows | awk -F'\t' -v t="$target" '$2 == t { print $1; exit }'
}

# Read a candidate base branch from a worktree's state.json (if present
# and the file has a non-null, non-empty `base_branch` field passing the
# metachar pre-check). Echoes the candidate or empty.
_state_base_branch() {
  local wt_path="$1"
  local sf="$wt_path/.dev-state/state.json"
  [ -f "$sf" ] || return 0
  jq empty "$sf" 2>/dev/null || return 0
  local candidate
  candidate=$(jq -r '.base_branch // ""' "$sf" 2>/dev/null || echo "")
  [ -n "$candidate" ] && [ "$candidate" != "null" ] || return 0
  _is_safe_ref "$candidate" || return 0
  printf '%s' "$candidate"
}

# Verify a ref candidate resolves via `git rev-parse --verify`. Returns 0
# on success.
_verify_ref() {
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  _is_safe_ref "$candidate" || return 1
  git rev-parse --verify "${candidate}^{commit}" >/dev/null 2>&1
}

# Resolve the script-level base branch via the chain (see SKILL.md §7.2).
# Always echoes a non-empty string; "" (empty) is reserved for the
# unresolved sentinel which is converted to "unresolved" at the print site.
_resolve_script_base() {
  local cand

  # Step 1: current worktree's state.json
  cand=$(_state_base_branch "$REPO_ROOT")
  if [ -n "$cand" ] && _verify_ref "$cand"; then
    printf '%s' "$cand"
    return 0
  fi

  # Step 2: origin/HEAD
  cand=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||' || true)
  if [ -n "$cand" ] && _verify_ref "$cand"; then
    printf '%s' "$cand"
    return 0
  fi

  # Step 3: main
  if _verify_ref "main"; then
    printf 'main'
    return 0
  fi

  # Step 4: master
  if _verify_ref "master"; then
    printf 'master'
    return 0
  fi

  # Step 5: current branch (non-detached)
  cand=$(git symbolic-ref --short HEAD 2>/dev/null || true)
  if [ -n "$cand" ]; then
    printf '%s' "$cand"
    return 0
  fi

  # Step 6: unresolvable
  printf ''
}

# Render a coloured + width-padded cell using the pad-then-wrap pattern.
# Args: color content width
# Output width is exactly `width` visible bytes when ANSI is empty (non-TTY)
# OR when content fits.
_print_cell() {
  local color="$1"
  local content="$2"
  local width="$3"
  printf '%s%-*s%s' "$color" "$width" "$content" "$RESET"
}

# Truncate to N bytes (Bash 3.2 substring). Phase names are pure ASCII so
# byte == character. Use cautiously for any UTF-8 content (today only
# repo-internal phase enums and short slugs flow through this).
_truncate() {
  local val="$1"
  local n="$2"
  if [ "${#val}" -gt "$n" ]; then
    printf '%s' "${val:0:$n}"
  else
    printf '%s' "$val"
  fi
}

# ──────────────────────────────────────────────────────────────
# Section 1 — Module progress
# ──────────────────────────────────────────────────────────────

print_section_1() {
  printf '%s== Module progress (docs/modules/MODULE-*.md §3.4) ==%s\n' "$BOLD" "$RESET"

  local dir="$REPO_ROOT/docs/modules"
  if [ ! -d "$dir" ]; then
    printf '%s(no docs/modules — skipped)%s\n\n' "$DIM" "$RESET"
    return 0
  fi

  local files=("$dir"/MODULE-*.md)
  if [ ! -e "${files[0]}" ]; then
    printf '%s(no MODULE-*.md files found)%s\n\n' "$DIM" "$RESET"
    return 0
  fi

  # Header row
  printf '%-32s  %-9s  %-6s  %s\n' "MODULE" "PASS/AC" "PCT" "STATUS"

  local total_passed=0
  local total_active=0
  local f title id passed active pct status_label color
  for f in "${files[@]}"; do
    [ -e "$f" ] || continue

    title=$(awk '/^# / { sub(/^# /, ""); print; exit }' "$f" 2>/dev/null || true)
    if [ -z "$title" ]; then
      title=$(basename "$f" .md)
    fi
    title=$(_sanitize "$title" "$(basename "$f")")
    title=$(_truncate "$title" 32)

    # Parse §3.4 ledger. Match table data rows of form:
    #   | MODULE-NNN-AC-xx | Y | passed | ... | ... |
    # Robust to single-trailing-space rows; rejects header (`AC ID`) and
    # the markdown separator (`|---|`).
    local stats
    stats=$(awk '
      /^### 3\.4/ { in_sec=1; next }
      in_sec && /^### / { exit }
      in_sec && /^## / { exit }
      in_sec && /^\|/ {
        # Split into pipe-delimited columns
        n = split($0, c, "|")
        if (n < 5) next
        # Trim each cell of leading/trailing whitespace
        for (i = 1; i <= n; i++) {
          gsub(/^[ \t]+|[ \t]+$/, "", c[i])
        }
        # Reject header + separator rows
        if (c[2] == "AC ID" || c[2] ~ /^-+$/) next
        # Active column = c[3], Status column = c[4]
        active = c[3]
        status = c[4]
        if (active == "Y") {
          active_count++
          if (status == "passed") passed_count++
        }
      }
      END {
        printf "%d %d", (passed_count + 0), (active_count + 0)
      }
    ' "$f")
    passed="${stats%% *}"
    active="${stats##* }"

    total_passed=$((total_passed + passed))
    total_active=$((total_active + active))

    if [ "$active" -eq 0 ]; then
      pct="—"
      status_label="Not Started"
      color="$DIM"
    else
      pct=$(( (passed * 100 + active / 2) / active ))
      if [ "$pct" -ge 100 ]; then
        status_label="Production"
      elif [ "$pct" -gt 0 ]; then
        status_label="In Progress"
      else
        status_label="Not Started"
      fi
      if [ "$pct" -ge 85 ]; then
        color="$GREEN"
      elif [ "$pct" -ge 70 ]; then
        color="$YELLOW"
      else
        color="$RED"
      fi
      pct="${pct}%"
    fi

    printf '%-32s  %-9s  ' "$title" "$passed/$active"
    _print_cell "$color" "$pct" 6
    printf '  %s\n' "$status_label"
  done

  # Trailing overall AC-weighted aggregate
  local overall_label="(overall AC-weighted)"
  if [ "$total_active" -eq 0 ]; then
    printf '%-32s  %-9s  ' "$overall_label" "$total_passed/$total_active"
    _print_cell "$DIM" "—" 6
    printf '  %s\n' "Not Started"
  else
    local overall=$(( (total_passed * 100 + total_active / 2) / total_active ))
    local ocolor
    if [ "$overall" -ge 85 ]; then ocolor="$GREEN"
    elif [ "$overall" -ge 70 ]; then ocolor="$YELLOW"
    else ocolor="$RED"; fi
    printf '%-32s  %-9s  ' "$overall_label" "$total_passed/$total_active"
    _print_cell "${BOLD}${ocolor}" "${overall}%" 6
    printf '  %s\n' "—"
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────
# Section 2 — Worktree status
# ──────────────────────────────────────────────────────────────

print_section_2() {
  printf '%s== Worktree status (git worktree × .dev-state/state.json) ==%s\n' "$BOLD" "$RESET"
  printf '%-44s  %-32s  %-11s  %-5s  %s\n' "WORKTREE" "TASK_ID" "PHASE" "ROUND" "UPDATED"

  local row wt_path branch sf task phase round updated pcolor
  while IFS=$'\t' read -r wt_path branch; do
    [ -n "$wt_path" ] || continue
    sf="$wt_path/.dev-state/state.json"
    if [ -f "$sf" ] && jq empty "$sf" 2>/dev/null; then
      task=$(_jq_field "$sf" "task_id")
      phase=$(_jq_field "$sf" "phase")
      round=$(_jq_field "$sf" "eval_round")
      updated=$(_jq_field "$sf" "updated_at")
      task=$(_sanitize "$task" "$wt_path:task_id")
      phase=$(_sanitize "$phase" "$wt_path:phase")
      round=$(_sanitize "$round" "$wt_path:eval_round")
      updated=$(_sanitize "$updated" "$wt_path:updated_at")
      case "$phase" in
        plan|docs) pcolor="$CYAN" ;;
        implement|audit|test|adversarial) pcolor="$YELLOW" ;;
        summary) pcolor="$GREEN" ;;
        *) pcolor="" ;;
      esac
    else
      task="(no /dev workflow)"
      phase="—"
      round="—"
      updated="—"
      pcolor=""
    fi

    local short
    short=$(_short_path "$wt_path")
    short=$(_truncate "$short" 44)
    task=$(_truncate "$task" 32)

    printf '%-44s  %-32s  ' "$short" "$task"
    _print_cell "$pcolor" "$(_truncate "$phase" 11)" 11
    printf '  %-5s  %s\n' "$round" "$updated"
  done < <(_worktree_rows)

  printf '\n'
}

# ──────────────────────────────────────────────────────────────
# Section 3 — Task branches (dev-task-*)
# ──────────────────────────────────────────────────────────────

print_section_3() {
  printf '%s== Task branches (dev-task-* ahead/behind + dirty) ==%s\n' "$BOLD" "$RESET"

  local script_base
  script_base=$(_resolve_script_base)

  local branches
  branches=$(git for-each-ref --format='%(refname:short)' 'refs/heads/dev-task-*' 2>/dev/null || true)

  if [ -z "$branches" ]; then
    printf '%s(no dev-task-* branches)%s\n' "$DIM" "$RESET"
    _print_section_3_footer "$script_base"
    return 0
  fi

  printf '%-30s  %-6s  %-6s  %-8s  %s\n' "BRANCH" "AHEAD" "BEHIND" "DIRTY" "WORKTREE"

  local br br_display owning_wt per_branch_base ab ahead behind dirty dcount dirty_color wt_label acolor bcolor
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    br_display=$(_sanitize "$br" "branch")
    br_display=$(_truncate "$br_display" 30)

    owning_wt=$(_branch_to_worktree "$br" || true)

    # Per-branch base: owning-worktree state.json wins (when verifiable);
    # fall through to script-level base otherwise.
    per_branch_base=""
    if [ -n "$owning_wt" ]; then
      local wt_state_base
      wt_state_base=$(_state_base_branch "$owning_wt" || true)
      if [ -n "$wt_state_base" ] && _verify_ref "$wt_state_base"; then
        per_branch_base="$wt_state_base"
      fi
    fi
    [ -z "$per_branch_base" ] && per_branch_base="$script_base"

    # Ahead / behind (pipefail-safe).
    if [ -n "$per_branch_base" ] && _is_safe_ref "$br" && _verify_ref "$per_branch_base"; then
      ab=$(git rev-list --left-right --count "${br}...${per_branch_base}" 2>/dev/null || echo "? ?")
      ahead=$(printf '%s' "$ab" | awk '{print $1}')
      behind=$(printf '%s' "$ab" | awk '{print $2}')
      [ -z "$ahead" ] && ahead="?"
      [ -z "$behind" ] && behind="?"
    else
      ahead="?"
      behind="?"
    fi

    # Dirty count.
    if [ -n "$owning_wt" ] && [ -d "$owning_wt" ]; then
      dcount=$( ( git -C "$owning_wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ' ) || echo "?" )
      if [ "$dcount" = "?" ] || [ -z "$dcount" ]; then
        dirty="?"
        dirty_color="$DIM"
      elif [ "$dcount" -gt 0 ]; then
        dirty="Y ($dcount)"
        dirty_color="$YELLOW"
      else
        dirty="N"
        dirty_color=""
      fi
    elif [ -n "$owning_wt" ]; then
      dirty="?"
      dirty_color="$DIM"
    else
      dirty="—"
      dirty_color="$DIM"
    fi

    # Worktree column + per-branch-base annotation.
    if [ -n "$owning_wt" ]; then
      wt_label=$(_short_path "$owning_wt")
      if [ -n "$per_branch_base" ] && [ "$per_branch_base" != "$script_base" ]; then
        wt_label="${wt_label}  (base: ${per_branch_base})"
      fi
    else
      wt_label="${DIM}(stale — no worktree)${RESET}"
    fi

    # Color ahead / behind.
    if [ "$ahead" != "?" ] && [ "$ahead" -gt 0 ] 2>/dev/null; then
      acolor="$GREEN"
    else
      acolor=""
    fi
    if [ "$behind" != "?" ] && [ "$behind" -gt 0 ] 2>/dev/null; then
      bcolor="$YELLOW"
    else
      bcolor=""
    fi

    printf '%-30s  ' "$br_display"
    _print_cell "$acolor" "$ahead" 6
    printf '  '
    _print_cell "$bcolor" "$behind" 6
    printf '  '
    _print_cell "$dirty_color" "$dirty" 8
    printf '  %s\n' "$wt_label"
  done <<< "$branches"

  _print_section_3_footer "$script_base"
}

_print_section_3_footer() {
  local base="$1"
  printf '\n'
  if [ -z "$base" ]; then
    printf '%s(comparison base: unresolved — detached HEAD and no main/master)%s\n' "$DIM" "$RESET"
  else
    printf '%s(comparison base: %s — local ref, not re-fetched; run `git fetch <remote>` to refresh)%s\n' "$DIM" "$base" "$RESET"
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

main() {
  print_section_1
  print_section_2
  print_section_3
}

main "$@"
