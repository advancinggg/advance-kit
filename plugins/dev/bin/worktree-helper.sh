#!/usr/bin/env bash
# worktree-helper.sh — backend for /dev worktree-* subcommands (2.8.0+)
#
# Subcommands: new | list | finish | remove
# Helper NEVER auto-executes destructive git operations (per CLAUDE.md
# risky-action principle); it prints copy-paste commands for the user to
# run, with the sole exception of `git worktree add` in `new` (creating
# a new worktree is the requested action and is safely-bounded by
# slug + collision validation). `--dry-run` flag on `new` and `remove`
# prints what WOULD be done without side effects.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  worktree-helper.sh new <slug> [--base <branch>] [--dry-run]
  worktree-helper.sh list
  worktree-helper.sh finish [--dry-run]
  worktree-helper.sh remove <path> [--dry-run]

  new       — create dev-task-<slug> branch + sibling worktree dir
  list      — enumerate worktrees + their /dev state.json (if any)
  finish    — print merge-suggestion sequence (gate: phase == "summary")
  remove    — print removal-suggestion sequence (gate: state.json absent
              OR phase == "summary")

Slug grammar (FROZEN, see VERSIONING.md 2.8.0 rule 6):
  primary regex:  ^[a-z][a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$
  secondary guard: rejects consecutive hyphens (--)
  reserved words: status, resume, abort, doctor, new, list, finish, remove
USAGE
  exit 2
}

[ $# -ge 1 ] || usage

SUBCMD=$1
shift

# ── repo-root anchor (worktree-aware) ──
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
  || { echo "worktree-helper: not inside a git repository" >&2; exit 1; }

# ──────────────────────────────────────────────────────────────
# Subcommand: new
# ──────────────────────────────────────────────────────────────
new_cmd() {
  local slug="${1:-}"; shift || true
  [ -n "$slug" ] || { echo "worktree-helper new: missing <slug>" >&2; usage; }

  local base=""
  local dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) base="${2:-}"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) echo "worktree-helper new: unknown arg '$1'" >&2; usage ;;
    esac
  done

  # Slug validation — primary regex
  if ! [[ "$slug" =~ ^[a-z][a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$ ]]; then
    echo "worktree-helper new: invalid slug '$slug'" >&2
    echo "  must match ^[a-z][a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?\$ (length 2-40, starts with letter, ends alnum)" >&2
    exit 1
  fi
  # Secondary guard — no consecutive hyphens (regex above can't enforce alone)
  if [[ "$slug" =~ -- ]]; then
    echo "worktree-helper new: invalid slug '$slug' (consecutive hyphens forbidden)" >&2
    exit 1
  fi
  # Reserved-word check
  case "$slug" in
    status|resume|abort|doctor|new|list|finish|remove)
      echo "worktree-helper new: slug '$slug' is a reserved word" >&2
      exit 1 ;;
  esac

  # Base-branch resolution (state.json → origin/HEAD → main → master → current)
  if [ -z "$base" ]; then
    if [ -f "$REPO_ROOT/.dev-state/state.json" ]; then
      base=$(jq -r '.base_branch // empty' "$REPO_ROOT/.dev-state/state.json" 2>/dev/null || true)
    fi
  fi
  if [ -z "$base" ]; then
    base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || true)
  fi
  [ -z "$base" ] && git rev-parse --verify main >/dev/null 2>&1 && base=main
  [ -z "$base" ] && git rev-parse --verify master >/dev/null 2>&1 && base=master
  if [ -z "$base" ]; then
    base=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ "$base" = "HEAD" ]; then
      echo "worktree-helper new: refusing detached-HEAD fallback as base branch" >&2
      echo "  Either pass --base <branch> explicitly, or git checkout a branch in the current worktree first." >&2
      exit 1
    fi
  fi
  if [ -z "$base" ]; then
    echo "worktree-helper new: could not resolve a base branch" >&2
    exit 1
  fi
  # Refuse explicit `--base HEAD` (or any value resolving to "HEAD") —
  # we require a branch, not an arbitrary detached commit-ish.
  if [ "$base" = "HEAD" ]; then
    echo "worktree-helper new: refusing --base HEAD (require a branch, not detached HEAD)" >&2
    exit 1
  fi

  # Accept either a local branch OR a remote-tracking branch (origin/<base>).
  # `git worktree add ... -b <new> <base>` accepts any commit-ish, but we
  # restrict to branch-shaped names: refuse if `<base>` resolves only as a
  # raw SHA (no symbolic ref).
  if git rev-parse --verify "refs/heads/$base" >/dev/null 2>&1; then
    : # local branch — OK
  elif git rev-parse --verify "refs/remotes/origin/$base" >/dev/null 2>&1; then
    base="origin/$base"
  else
    echo "worktree-helper new: base '$base' is not a local branch or origin/$base" >&2
    exit 1
  fi

  # Target path: sibling of REPO_ROOT
  local repo_basename target_dir branch_name
  repo_basename=$(basename "$REPO_ROOT")
  target_dir="$(dirname "$REPO_ROOT")/${repo_basename}-${slug}"
  branch_name="dev-task-${slug}"

  # Refuse if target dir already exists OR branch already exists
  if [ -e "$target_dir" ]; then
    echo "worktree-helper new: target dir already exists: $target_dir" >&2
    exit 1
  fi
  if git rev-parse --verify "$branch_name" >/dev/null 2>&1; then
    echo "worktree-helper new: branch already exists: $branch_name" >&2
    exit 1
  fi

  if [ "$dry_run" -eq 1 ]; then
    cat <<EOF
worktree-helper new --dry-run:
  Slug:     $slug
  Base:     $base
  Branch:   $branch_name
  Target:   $target_dir
  Command:  git worktree add "$target_dir" -b "$branch_name" "$base"
  Next steps for user (after dry-run is removed):
    cd "$target_dir"
    # Start a NEW Claude Code session here, then run:
    /dev <your task description>
EOF
    return 0
  fi

  # Execute
  if git worktree add "$target_dir" -b "$branch_name" "$base"; then
    cat <<EOF
worktree-helper new: created
  Branch:  $branch_name (from $base)
  Path:    $target_dir

Next steps:
  cd "$target_dir"
  # Start a NEW Claude Code session here, then run:
  /dev <your task description>
EOF
  else
    echo "worktree-helper new: git worktree add failed" >&2
    exit 1
  fi
}

# ──────────────────────────────────────────────────────────────
# Subcommand: list
# ──────────────────────────────────────────────────────────────
list_cmd() {
  printf '%s\t%s\t%s\t%s\t%s\n' "PATH" "TASK_ID" "PHASE" "EVAL_ROUND" "UPDATED_AT"

  # Parse `git worktree list --porcelain`: paths follow "worktree " prefix
  local path task_id phase eval_round updated_at state_file
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        path="${line#worktree }"
        state_file="${path}/.dev-state/state.json"
        if [ -f "$state_file" ]; then
          task_id=$(jq -r '.task_id // "—"' "$state_file" 2>/dev/null || echo "—")
          phase=$(jq -r '.phase // "—"' "$state_file" 2>/dev/null || echo "—")
          eval_round=$(jq -r '.eval_round // "—"' "$state_file" 2>/dev/null || echo "—")
          updated_at=$(jq -r '.updated_at // "—"' "$state_file" 2>/dev/null || echo "—")
        else
          task_id="—"; phase="—"; eval_round="—"; updated_at="—"
        fi
        # Never emit literal "null"
        [ "$task_id" = "null" ] && task_id="—"
        [ "$phase" = "null" ] && phase="—"
        [ "$eval_round" = "null" ] && eval_round="—"
        [ "$updated_at" = "null" ] && updated_at="—"
        printf '%s\t%s\t%s\t%s\t%s\n' "$path" "$task_id" "$phase" "$eval_round" "$updated_at"
        ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)
}

# ──────────────────────────────────────────────────────────────
# Subcommand: finish
# ──────────────────────────────────────────────────────────────
finish_cmd() {
  local dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      *) echo "worktree-helper finish: unknown arg '$1'" >&2; usage ;;
    esac
  done

  local state_file="$REPO_ROOT/.dev-state/state.json"
  if [ ! -f "$state_file" ]; then
    echo "worktree-helper finish: no .dev-state/state.json in current worktree" >&2
    echo "  Use /dev worktree-remove for aborted/orphaned task worktrees." >&2
    exit 1
  fi

  # Derive main worktree path + current branch
  local main_wt branch_name base_branch task_branch
  branch_name=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  # Refuse if current dir is the main worktree. Detection: main worktree's
  # `.git` is a real directory; linked worktrees have `.git` as a file
  # containing "gitdir: /path/to/.git/worktrees/<name>". This is more
  # reliable than parsing porcelain output ordering.
  if [ -d "$REPO_ROOT/.git" ]; then
    echo "worktree-helper finish: refusing to run in main worktree (only meaningful in a task worktree)." >&2
    echo "  Main worktree's /dev SUMMARY does not need 'finish' — there's nothing to merge back." >&2
    exit 1
  fi

  # Main worktree is the parent of git-common-dir. Use --absolute when
  # available; otherwise canonicalize manually for portability.
  local common_dir
  common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
  case "$common_dir" in
    /*) ;;
    *)  common_dir="$REPO_ROOT/$common_dir" ;;
  esac
  # Resolve symlinks via python3 (matches check-phase.sh portability pattern)
  main_wt=$(python3 -c "import os,sys; print(os.path.dirname(os.path.realpath(sys.argv[1])))" "$common_dir" 2>/dev/null) \
    || main_wt=$(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')

  # Refuse on detached HEAD (no branch to merge)
  if [ "$branch_name" = "HEAD" ] || [ -z "$branch_name" ]; then
    echo "worktree-helper finish: current worktree has detached HEAD; cannot derive a task branch to merge." >&2
    exit 1
  fi

  local phase
  phase=$(jq -r '.phase // empty' "$state_file" 2>/dev/null || true)
  if [ "$phase" != "summary" ]; then
    echo "worktree-helper finish: gate failure — phase is '$phase' (expected 'summary')" >&2
    echo "  Complete /dev SUMMARY first, or use /dev worktree-remove for aborted tasks." >&2
    exit 1
  fi

  base_branch=$(jq -r '.base_branch // "main"' "$state_file" 2>/dev/null || echo "main")
  task_branch="$branch_name"

  if [ "$dry_run" -eq 1 ]; then
    cat <<EOF
worktree-helper finish [DRY-RUN]:
  Phase gate:    PASS (phase=$phase)
  Main worktree: $main_wt
  Task branch:   $task_branch
  Base branch:   $base_branch
  (Re-run without --dry-run to print the merge-suggestion block.)
EOF
    return 0
  fi

  cat <<EOF
worktree-helper finish: SUMMARY done. Run these in the main worktree to merge:

  cd "$main_wt"
  git checkout "$base_branch"
  git pull --ff-only            # if origin/$base_branch is configured
  git merge --no-ff "$task_branch"
  git worktree remove "$REPO_ROOT"
  git branch -d "$task_branch"  # safety: -d (not -D), refuses if not merged

EOF
}

# ──────────────────────────────────────────────────────────────
# Subcommand: remove
# ──────────────────────────────────────────────────────────────
remove_cmd() {
  local path="${1:-}"; shift || true
  [ -n "$path" ] || { echo "worktree-helper remove: missing <path>" >&2; usage; }

  local dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      *) echo "worktree-helper remove: unknown arg '$1'" >&2; usage ;;
    esac
  done

  # Validate <path> is a known worktree (not main).
  # Main detection same logic as finish_cmd: `.git` is a dir for main,
  # a file for linked. Don't rely on porcelain ordering.
  local wt_path is_known_wt=0
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        wt_path="${line#worktree }"
        if [ "$wt_path" = "$path" ]; then
          is_known_wt=1
        fi
        ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)

  if [ "$is_known_wt" -eq 0 ]; then
    echo "worktree-helper remove: '$path' is not a registered git worktree" >&2
    exit 1
  fi
  if [ -d "$path/.git" ]; then
    echo "worktree-helper remove: refusing to remove main worktree (its .git is a directory, not a worktree pointer file)" >&2
    exit 1
  fi

  # Phase gate: state.json absent OR phase == "summary"
  local state_file="${path}/.dev-state/state.json"
  if [ -f "$state_file" ]; then
    local phase
    phase=$(jq -r '.phase // empty' "$state_file" 2>/dev/null || true)
    if [ "$phase" != "summary" ]; then
      echo "worktree-helper remove: gate failure — phase is '$phase' (expected 'summary' or absent)" >&2
      echo "  Run /dev abort first (deletes state.json) or complete SUMMARY (/dev worktree-finish), then try again." >&2
      exit 1
    fi
  fi

  # Resolve task branch from worktree HEAD
  local branch_name
  branch_name=$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  if [ "$dry_run" -eq 1 ]; then
    cat <<EOF
worktree-helper remove [DRY-RUN]:
  Path:        $path
  Branch:      $branch_name
  Phase gate:  PASS
  (Re-run without --dry-run to print the removal-suggestion block.)
EOF
    return 0
  fi

  cat <<EOF
worktree-helper remove: ready. Run these to clean up:

  git worktree remove "$path"
EOF
  if [ -n "$branch_name" ] && [ "$branch_name" != "HEAD" ]; then
    echo "  git branch -d \"$branch_name\"   # safety: -d (not -D), refuses if unmerged"
    echo ""
  fi
}

# ──────────────────────────────────────────────────────────────
# Dispatch
# ──────────────────────────────────────────────────────────────
case "$SUBCMD" in
  new)    new_cmd "$@" ;;
  list)   list_cmd "$@" ;;
  finish) finish_cmd "$@" ;;
  remove) remove_cmd "$@" ;;
  *)      usage ;;
esac
