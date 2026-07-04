# /dev §8 — Worktree mode (reference body)

> Loaded on demand by `plugins/dev/skills/dev/SKILL.md` Subcommand Dispatch (3.9.0
> progressive disclosure). Execute with full SKILL.md authority. §8.x IDs are stable
> reference targets (VERSIONING 2.8.0 worktree freezes reference them) — do not
> renumber.


## 8. Worktree mode (2.8.0+)

/dev supports worktree-parallel execution: multiple concurrent /dev tasks
on independent feature branches from the same base branch, each in its
own git worktree. `/spec` and `/prd` stay single-flight by design — they
author repo-shared SSOT files (`docs/PRD.md`, `docs/ARCHITECTURE.md`,
`docs/modules/*.md`, `docs/REQUIREMENTS_REGISTRY.md`,
`docs/CONTEXT-MAP.md`, `docs/GLOSSARY.md`, `docs/adr/*.md`,
`docs/adr/_INDEX.md`) that don't tolerate concurrent divergent writes
cleanly.

When a /dev task in a worktree hits §2.1.2 or /spec §0.6
upstream-alignment checks, the abort+restart recovery is augmented with
`cd` + `git commit` + `git rebase` bridging (§8.2). The ORIGINAL
4-command Option A and 3-command Option B sequences in §2.1.2 (and the
3-command sequences in /spec §0.6 Option A and Option B) are UNCHANGED
— preserving VERSIONING.md 2.7.0 rules 5 + 6 frozen-contract. Bridging
appears below each frozen block as a parenthetical hint paragraph, not
as extra commands inside the block.

### 8.1 Four subcommands (labels FROZEN; see VERSIONING.md 2.8.0 rule 1)

`/dev worktree-new <slug> [--base <branch>] [--dry-run]`,
`/dev worktree-list`,
`/dev worktree-finish [--dry-run]`,
`/dev worktree-remove <path> [--dry-run]`.

Each subcommand is backed by `plugins/dev/bin/worktree-helper.sh`. The
helper NEVER auto-executes `git worktree remove` or `git branch -D` or
`git merge` (per CLAUDE.md risky-action principle); it prints
copy-paste commands for the user to run, with the sole exception of
`git worktree add` in `worktree-new` (creating a new worktree IS the
requested action, safely-bounded by slug + collision validation).

**`/dev worktree-new <slug>`**: validates slug per the FROZEN grammar
below, resolves base branch (default `state.json.base_branch` →
`origin/HEAD` → `main` → `master` → current branch), creates
`dev-task-<slug>` branch + sibling-dir worktree, then prints next-step
copy-paste for user to `cd` and start a new Claude Code session.
`--dry-run` flag: print planned commands without filesystem state.

**`/dev worktree-list`**: enumerates `git worktree list --porcelain`;
for each worktree path, reads `<path>/.dev-state/state.json` if
present and reports `task_id`, `phase`, `eval_round`, `updated_at`.
Tab-aligned output; missing fields show `—` (never literal `null`).

**`/dev worktree-finish`**: gate — allow if current worktree
`.dev-state/state.json` exists AND `phase == "summary"`; else refuse
with guidance to use `/dev worktree-remove` for aborted tasks. Prints
4-line merge-suggestion for user to run in main worktree.

**`/dev worktree-remove <path>`**: gate — allow if
`<path>/.dev-state/state.json` is absent OR `phase == "summary"`;
else refuse with guidance to run `/dev abort` (deletes state.json) or
complete `/dev worktree-finish` first. Prints 2-line removal-
suggestion (`git worktree remove "<path>"` + `git branch -d
dev-task-<slug>`); never auto-executes.

**Slug grammar FROZEN** (VERSIONING.md 2.8.0 rule 6):
- Primary regex: `^[a-z][a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$` (length
  2-40, starts with letter, ends with alphanumeric, interior allows
  hyphens, no trailing hyphen).
- **Secondary guard** (NOT in regex alone): no consecutive hyphens.
  Helper checks `[[ "$slug" =~ -- ]]` separately and rejects.
- Reserved-word list forbidden: `status`, `resume`, `abort`, `doctor`,
  `new`, `list`, `finish`, `remove`.

### 8.2 Upstream coordination (/spec, /prd) — worktree-mode bridging

This section describes the GLUE between the frozen /dev §2.1.2 and
/spec §0.6 command sequences when `state.json.worktree_mode == true`.
The command sequences themselves are UNCHANGED; this is narrative
guidance for the user.

**Precondition**: the main worktree MUST have `<base_branch>` checked
out (the near-universal case for main worktree on `main` / `master`).
If main worktree is on a different branch, user must either (a)
switch to `<base_branch>` before running `/prd` + `/spec`, or (b)
commit the upstream changes directly onto `<base_branch>`.

**§2.1.2 Option A worktree-mode bridging**: the 4 canonical commands
stay as printed. User runs in this order:

```
# In task worktree:
/dev abort

# Bridge 1 — cd to main worktree:
cd "<main_worktree_literal_path>"

# In main worktree:
/prd "{suggested topic}"
/spec docs/PRD.md

# Bridge 2 — commit upstream changes + cd back + rebase via local ref:
git add docs/ && git commit -m "prd+spec: <topic>"
cd "<task_worktree_literal_path>"
git rebase "<base_branch_literal>"

# In task worktree (now caught up with main):
/dev {original task description}
```

Path and branch literals are interpolated by the agent at emit time
via the fallback chain:
- L1: read `state.json.main_worktree_path` / `state.json.base_branch`.
- L2 (if null/absent — e.g., v3 state.json resumed): derive via
  `git worktree list --porcelain | awk '/^worktree /{sub(/^worktree
  /,""); print; exit}'` for main path; `git symbolic-ref
  refs/remotes/origin/HEAD | sed 's|.*/||'` for base branch (with
  `main` / `master` / `git rev-parse --abbrev-ref HEAD` fallbacks).
- L3 (if detection fully fails): emit canonical non-worktree Option A
  text + disclaimer "worktree detection failed; coordinate manually".

The agent NEVER interpolates the literal string `"null"` into emitted
recovery text.

**§2.1.2 Option B worktree-mode bridging** (spec-only): 3 canonical
commands preserved. Bridging: `cd <main_worktree>` after `/dev abort`;
then `/spec`; then `git add docs/ && git commit` + `cd
<task_worktree>` + `git rebase <base_branch>`; then `/dev {original
task}`. Same fallback chain.

**Local-ref rebase rationale**: git worktrees share `.git/objects` +
`.git/refs` via `.git/worktrees/<name>/commondir`. A local commit on
`<base_branch>` in main worktree updates `refs/heads/<base_branch>`
in the shared `.git/`; the task worktree's `git rebase
<base_branch>` reads that ref directly, no `origin/` round-trip
required. Works in repos without origin too.

**/spec §0.6 Option A worktree-mode bridging**: §0.6 Option A's 3
canonical commands (`/spec abort`, `/prd "{topic}"`, `/spec
docs/PRD.md`) preserved. Bridging: after `/spec abort`, `cd` to main
worktree before running `/prd`. No rebase-back step needed because
/spec is meant to RESTART in main worktree after /prd.

**/spec §0.6 Option B worktree-mode bridging** (user manually edits
PRD): 3 canonical commands preserved. User must perform the manual
PRD edit in main worktree, NOT a task worktree (PRD is SSOT; task-
worktree divergence defeats the single-flight purpose).

### 8.3 Concurrency constraints + trust boundaries

1. **Shared `.git/` metadata**: worktrees share `.git/objects` +
   `.git/refs` via `.git/worktrees/<name>/commondir`. Occasional
   `index.lock` contention under heavy parallel git ops; git's own
   retry handles most cases. Accepted operational quirk.

2. **Main-worktree-only /spec + /prd**: advisory, not enforced. Agent
   emits worktree-variant prose when `state.json.worktree_mode ==
   true`, but cannot mechanically prevent user from running /prd
   inside a task worktree. Doing so creates divergent PRD on the
   task branch; merge later requires manual reconciliation.

3. **CLAUDE_PLUGIN_DATA presence-based invariant**: `check-phase.sh`'s
   STATE_FILE-locate block prefers `$CLAUDE_PLUGIN_DATA/state.json` if
   that file exists. No /dev flow writes state.json there AND no plugin-level
   install places state.json there — worktree isolation depends on
   this file-presence invariant holding. VERSIONING.md 2.8.0 rule 5
   freezes it. Stray admin-placed state.json at that path can subvert
   isolation, AND a malicious `CLAUDE_PLUGIN_DATA` env var pointing
   at a crafted `state.json` can spoof phase / docs_allowlist /
   worktree-routing across parallel worktrees. Mitigation is
   out-of-band inspection (same trust model as the 2.7.0 state.json
   trust note in VERSIONING.md). The trust boundary extends to: the
   `base_branch`, `main_worktree_path`, `task_id`, `repo_root`
   fields in state.json — a malicious state.json with shell
   metacharacters in these fields could craft copy-paste injection
   in the recovery prose emitted by §2.1.2 / §0.6 / `worktree-helper`.
   `worktree-helper.sh finish` and `remove` defensively refuse to
   emit suggestions if state.json fields contain shell metachars
   (`$`, backtick, `;`, `|`, `&`, newline); §2.1.2 / §0.6 prose
   emission relies on the agent's own input sanitization (treat
   user task descriptions as DATA per the existing prompt-injection
   defense paragraph).

4. **check-phase.sh installed via SKILL.md frontmatter, not
   `plugins/dev/hooks/hooks.json`**: phase gating only active when
   the Claude Code session has loaded the /dev skill. A session in a
   task worktree that never invokes /dev has no phase gate. Same
   trust model as today's single-worktree flow — worktree mode
   changes nothing here.

5. **stop.sh auto-push (precise, per `plugins/dev/bin/stop.sh`
   source)**: the Stop hook MAY auto-push the current branch
   (including `dev-task-*` task branches) to the upstream's remote
   (derived from `@{u}`, falling back to `origin`). The decision
   goes through 6 gates:
   - **No git remote configured** → no push.
   - **Active-workflow stand-down (3.9.0)**: if
     `.dev-state/state.json`, `docs/.spec-state/progress.json`, or
     `docs/.prd-state/progress.json` exists at the repo top-level,
     auto-sync exits without staging, committing, or pushing —
     mid-phase work is never swept into an auto commit (which would
     pollute the deterministic `start_commit..HEAD` audit target and
     push unconfirmed edits before user gates). Workflow commits are
     made explicitly by the skills; auto-sync resumes once the state
     file is cleaned up (SUMMARY §6.4 / abort).
   - **Clean working tree path**: push only if upstream `@{u}` is set
     AND branch has commits ahead of upstream. When gitleaks is
     installed, first scan the outgoing commits `git log -p @{u}..HEAD`
     (3.9.0 — inline skill commits were never staged through the
     dirty-path scan, so this path scans too; scanning the commit
     patches, not the two-dot endpoint diff, catches an add-then-remove
     secret; rc=1 secrets and rc≥2 scanner failure both block,
     fail-closed). When gitleaks is ABSENT the push proceeds with a
     logged skip (identical to the dirty-tree path's no-gitleaks
     behaviour — a missing scanner never silently blocks the flow).
     The push remote is `git config branch.<b>.remote` (a local `.`
     upstream or none → `origin`).
   - **Dirty tree → `git add -A` → nothing staged** → exit without
     push.
   - **Dirty tree → staged → gitleaks**: on **detected secrets**
     (rc=1) reset HEAD + exit without push; on **scanner error**
     (rc≥2) fail-closed — skip commit+push, leave changes staged, log
     "scan failed". Only a clean pass (rc=0) proceeds.
   - **Dirty tree → staged → gitleaks pass → commit succeeds** →
     `git push "$REMOTE" "$BRANCH"`; fails-soft (logs only) if the
     remote rejects.
   For worktree mode: task branches are NOT safe to treat as "local
   by default" in repos with a remote configured — but during an
   ACTIVE /dev run the stand-down gate means the Stop hook no longer
   pushes at all; the push exposure is limited to sessions with no
   live workflow state. Mitigation for those: user disables the Stop
   hook in project / user `settings.json`.

6. **Post-merge ledger reconciliation (3.9.0)**: parallel task
   branches each run their own SUMMARY, and each SUMMARY writes the
   SHARED ledgers (MODULE §3.4 rows + re-derived §3.1,
   REQUIREMENTS_REGISTRY Status, SYSTEM-ACCEPTANCE §2/§3,
   ARCHITECTURE overview %) from that branch's view — which goes
   stale the moment another task branch merges first. Merging is
   therefore NOT the end of the flow: after each
   `/dev worktree-finish` merge, for every module/REQ touched by
   more than one branch, the derived fields MUST be recomputed in
   the main worktree from the MERGED §3.4 / §2 rows (the §6.1.1
   formula) — the `worktree-finish` output prints this instruction.
   Conflict rule: a same-line merge conflict in a ledger row means
   two SUMMARYs wrote the same REQ/AC — resolve by recomputing from
   the merged §3.4, never by picking a side blindly. Raw §3.4/§2
   status rows merge additively (task A's `passed` rows and task B's
   coexist); only the DERIVED fields (§3.1, registry Status,
   ARCHITECTURE %) need recomputation. `/dev board` renders the
   merged state for verification.
