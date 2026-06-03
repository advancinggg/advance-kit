#!/usr/bin/env bash
# board.sh — read-only /dev board snapshot dashboard (2.9.0+)
#
# Aggregates three sections of repository state to stdout:
#   1. Module progress — docs/modules/MODULE-*.md §3.4 ledger via the
#      SKILL.md §6.1.1 formula (passed * 100 + active / 2) / active, plus a
#      trailing System E2E readiness row from docs/SYSTEM-ACCEPTANCE.md §2
#      (2.10.0+, axis 2; inert when the file is absent).
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

# Sanitise externally-sourced display strings — replace shell-metachars,
# control chars (including ESC for ANSI), and other terminal-injection
# vectors with `?` and emit a stderr warning. Same contract shape as
# worktree-helper.sh list_cmd. NEVER used for control-flow values that
# flow into git invocations — those use the reject-on-metachar pre-check
# in _is_safe_ref instead.
_sanitize() {
  local val="$1"
  local source_label="${2:-(unknown)}"
  case "$val" in
    *'$'*|*'`'*|*';'*|*'|'*|*'&'*|*$'\n'*|*$'\r'*|*$'\t'*|*'<'*|*'>'*|*$'\033'*|*$'\x7f'*)
      echo "board.sh: WARNING — field for $source_label contains shell metacharacter or control char; displayed as ?" >&2
      printf '?'
      return ;;
  esac
  printf '%s' "$val"
}

# Strict reject-on-metachar test for values flowing into git ref-spec
# parsing OR into display interpolation that bypasses _sanitize. Returns
# 0 if value is safe, non-zero otherwise. Rejects the same metachar set
# as _sanitize (including ESC and DEL — ANSI / terminal-injection
# vectors) PLUS the empty string. Action differs (return vs substitute);
# the metachar coverage is intentionally identical.
_is_safe_ref() {
  local val="$1"
  [ -n "$val" ] || return 1
  case "$val" in
    *'$'*|*'`'*|*';'*|*'|'*|*'&'*|*$'\n'*|*$'\r'*|*$'\t'*|*'<'*|*'>'*|*$'\033'*|*$'\x7f'*)
      return 1 ;;
  esac
  return 0
}

# Render path with $HOME → ~ shortening (display only; path is
# filesystem-trusted). The `"$HOME"` quoting inside the parameter
# expansion is REQUIRED — without it, glob metachars in $HOME would be
# treated as a pattern, not a literal prefix.
_short_path() {
  local p="$1"
  if [ -n "${HOME:-}" ] && [ "${p#"$HOME"}" != "$p" ]; then
    printf '~%s' "${p#"$HOME"}"
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
# Path may contain whitespace — the porcelain format is `worktree <path>`
# with `<path>` extending to end-of-line; we strip the literal `worktree `
# prefix instead of relying on `$2`.
_worktree_rows() {
  git worktree list --porcelain 2>/dev/null | awk '
    /^worktree / { sub(/^worktree /, ""); p=$0; next }
    /^branch / {
      b=$2; sub("refs/heads/", "", b);
      print p "\t" b; p=""; b=""; next
    }
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

  # Step 5: current branch (non-detached). Gate via _is_safe_ref so the
  # safety guarantee in §7.4 holds across ALL chain steps — git ref-name
  # rules are restrictive but the chain-design promise in the doc says
  # every candidate that survives passed _is_safe_ref, not "trust git's
  # ref-name rules for this one step".
  cand=$(git symbolic-ref --short HEAD 2>/dev/null || true)
  if [ -n "$cand" ] && _is_safe_ref "$cand"; then
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
  local f title passed active pct status_label color
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
      # Derived status keyed off RAW counts (matches SKILL.md §6.1.1
      # table), NOT the rounded percentage — so passed=1, active=201
      # (pct rounds to 0) correctly renders "In Progress", not
      # "Not Started".
      if [ "$passed" -eq 0 ]; then
        status_label="Not Started"
      elif [ "$passed" -ge "$active" ]; then
        status_label="Production"
      else
        status_label="In Progress"
      fi
      # Percentage colour band is independent of status text (see
      # SKILL.md §7.3 "two-axis classification").
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

  # ── System E2E readiness (axis 2, 2.10.0+) — docs/SYSTEM-ACCEPTANCE.md ──
  # A distinct trailing row so the two axes sit adjacent (module AC coverage
  # above, system E2E readiness here) and are NEVER collapsed into one number.
  # 3.6.0/K9: a single awk pass also reads §1.1 (Type, for the per-Type breakdown)
  # and §3 (Accepted deferrals). The % still counts a deferral as NOT-passed — the
  # "(N deferred-accepted)" annotation explains the shortfall rather than hiding it.
  # Inert when the file is absent (pre-2.10.0 / no Witness:e2e REQ).
  local sysfile="$REPO_ROOT/docs/SYSTEM-ACCEPTANCE.md"
  if [ -f "$sysfile" ]; then
    local sys_stats sys_passed sys_active dc fp fa np na ep ea
    sys_stats=$(awk '
      /^### 1\.1 / { sec="11"; next }
      /^### /      { sec="";   next }
      /^## 2\. System AC Ledger/ { sec="2"; next }
      /^## 3\. Accepted system-acceptance deferrals/ { sec="3"; next }
      /^## /       { sec="";   next }
      /^\|/ {
        n = split($0, c, "|")
        if (n < 4) next
        if (sec == "2" && n < 6) next        # §2: keep the pre-K9 ≥6-field guard exactly (strict readiness-count equivalence on malformed ledgers)
        for (i = 1; i <= n; i++) { gsub(/^[ \t]+|[ \t]+$/, "", c[i]) }
        if (c[2] !~ /^SYS-AC-/) next          # skip header / separator / "—" placeholder
        if (sec == "11") { kind[c[2]] = c[4] }          # §1.1: c[4]=Type
        else if (sec == "2") {                          # §2: c[4]=Active, c[5]=Status
          if (c[4] == "Y") { act[c[2]] = 1; if (c[5] == "passed") pass[c[2]] = 1 }
        }
        else if (sec == "3") { defr[c[2]] = 1 }          # §3: accepted deferral
      }
      END {
        ap = aa = 0
        for (id in act) { aa++; if (id in pass) ap++; t = kind[id]; ta[t]++; if (id in pass) tp[t]++ }
        dcn = 0; for (id in defr) dcn++
        printf "%d %d %d %d %d %d %d %d %d", ap, aa, dcn, \
          (tp["functional"]+0), (ta["functional"]+0), \
          (tp["nfr/slo"]+0),    (ta["nfr/slo"]+0), \
          (tp["error-path"]+0), (ta["error-path"]+0)
      }
    ' "$sysfile")
    read -r sys_passed sys_active dc fp fa np na ep ea <<< "$sys_stats" || true
    : "${sys_passed:=0}" "${sys_active:=0}" "${dc:=0}" "${fp:=0}" "${fa:=0}" "${np:=0}" "${na:=0}" "${ep:=0}" "${ea:=0}"
    local sys_label="(system E2E readiness)"
    if [ "$sys_active" -eq 0 ]; then
      printf '%-32s  %-9s  ' "$sys_label" "$sys_passed/$sys_active"
      _print_cell "$DIM" "—" 6
      printf '  %s\n' "(no journeys)"
    else
      local syspct=$(( (sys_passed * 100 + sys_active / 2) / sys_active ))
      local scolor
      if [ "$syspct" -ge 85 ]; then scolor="$GREEN"
      elif [ "$syspct" -ge 70 ]; then scolor="$YELLOW"
      else scolor="$RED"; fi
      local sys_trail="system"
      [ "$dc" -gt 0 ] && sys_trail="system ($dc deferred-accepted)"
      printf '%-32s  %-9s  ' "$sys_label" "$sys_passed/$sys_active"
      _print_cell "${BOLD}${scolor}" "${syspct}%" 6
      printf '  %s\n' "$sys_trail"
      # B — per-Type breakdown (§1.1 Type joined to §2 status); only types with ≥1 Active SYS-AC
      local tparts=""
      [ "$fa" -gt 0 ] && tparts="${tparts}functional ${fp}/${fa} · "
      [ "$na" -gt 0 ] && tparts="${tparts}nfr/slo ${np}/${na} · "
      [ "$ea" -gt 0 ] && tparts="${tparts}error-path ${ep}/${ea} · "
      tparts="${tparts% · }"
      [ -n "$tparts" ] && printf '%sby type: %s%s\n' "$DIM" "$tparts" "$RESET"
    fi
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────
# Section 2 — Worktree status
# ──────────────────────────────────────────────────────────────

print_section_2() {
  printf '%s== Worktree status (git worktree × .dev-state/state.json) ==%s\n' "$BOLD" "$RESET"
  printf '%-44s  %-32s  %-11s  %-5s  %-7s  %s\n' "WORKTREE" "TASK_ID" "PHASE" "ROUND" "DEFER" "UPDATED"

  local row wt_path branch sf task phase round updated pcolor deferred dcolor defF defS
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
      # ── DEFER column (3.6.0/K9): Nf = deferred_findings (K6), Ns =
      #    system_acceptance_deferred (K4). Both are accepted-but-unverified gaps;
      #    counts only (numeric jq lengths, never user strings → no sanitize). ──
      defF=$(jq -r '(.deferred_findings // []) | length' "$sf" 2>/dev/null); defF=${defF//[!0-9]/}; defF=${defF:-0}
      defS=$(jq -r '(.system_acceptance_deferred // []) | length' "$sf" 2>/dev/null); defS=${defS//[!0-9]/}; defS=${defS:-0}
      if [ "$defF" -gt 0 ] || [ "$defS" -gt 0 ]; then
        deferred="${defF}f/${defS}s"; dcolor="$YELLOW"
      else
        deferred="—"; dcolor="$DIM"
      fi
    else
      task="(no /dev workflow)"
      phase="—"
      round="—"
      updated="—"
      pcolor=""
      deferred="—"; dcolor="$DIM"
    fi

    local short
    short=$(_short_path "$wt_path")
    short=$(_truncate "$short" 44)
    task=$(_truncate "$task" 32)

    printf '%-44s  %-32s  ' "$short" "$task"
    _print_cell "$pcolor" "$(_truncate "$phase" 11)" 11
    printf '  %-5s  ' "$round"
    _print_cell "$dcolor" "$deferred" 7
    printf '  %s\n' "$updated"
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

    # Dirty count. Gate on `is-inside-work-tree` first so we distinguish
    # "git worked, 0 modified files" (→ N) from "git failed, can't tell"
    # (→ ?). The old subshell pattern silently misclassified the failure
    # case as N because `wc -l` always prints `0` even on an empty pipe.
    if [ -n "$owning_wt" ] && [ -d "$owning_wt" ] \
       && git -C "$owning_wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      dcount=$(git -C "$owning_wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo "")
      if [ -n "$dcount" ] && [ "$dcount" -gt 0 ] 2>/dev/null; then
        dirty="Y ($dcount)"
        dirty_color="$YELLOW"
      elif [ "$dcount" = "0" ]; then
        dirty="N"
        dirty_color=""
      else
        dirty="?"
        dirty_color="$DIM"
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
        # Sanitise per_branch_base before display interpolation —
        # _is_safe_ref accepts only what's safe for git, but the
        # display layer must also resist ANSI / control injection
        # from a tampered state.json. _sanitize handles that.
        local pbb_display
        pbb_display=$(_sanitize "$per_branch_base" "owning-worktree:base_branch")
        wt_label="${wt_label}  (base: ${pbb_display})"
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
