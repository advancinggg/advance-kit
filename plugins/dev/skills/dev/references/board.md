# /dev §7 — board (snapshot dashboard) (reference body)

> Loaded on demand by `plugins/dev/skills/dev/SKILL.md` Subcommand Dispatch (3.9.0
> progressive disclosure). Execute with full SKILL.md authority. §7.x IDs are stable
> reference targets — do not renumber.


## 7. /dev board (snapshot dashboard, 2.9.0+)

A read-only meta-feature (NOT a state-machine phase — `Phase N` naming is reserved
for the state.json-tracked phases enforced by `check-phase.sh`). Invoked as the
`board` subcommand and backed by `plugins/dev/bin/board.sh`. Aggregates three
sections of repository state to stdout.

### 7.1 Three output sections

**Section 1 — Module progress.** For every `docs/modules/MODULE-*.md`, parse the
§3.4 ledger and apply the §6.1.1 formula
`pct = (passed × 100 + active / 2) ÷ active`. Render
`module title  passed/active  pct  derived status` per module + a trailing
overall AC-weighted aggregate row `sum_passed / sum_active`. Denominator-zero
guard everywhere: zero `Active=Y` AC → percentage cell renders as `—`
(NOT `0%`, NOT `—%`); status text "Not Started".

**Section 1 also renders the System E2E readiness axis (2.10.0+).** When
`docs/SYSTEM-ACCEPTANCE.md` exists, parse its §2 ledger (Active=Y SYS-AC,
Status=passed) with the same formula + colour band + `—` guard, and render a
trailing `(system E2E readiness)  passed/active  pct  system` row directly under
the module aggregate. The two axes are shown adjacent and **never merged** —
module AC coverage answers "are the parts proven?", system readiness answers
"does the wired whole run?". Absent file → row omitted (pre-2.10.0 / no
`Witness:e2e` REQ). **3.6.0/K9 additions** (same single read-only pass): (a) the
trailing label gains `(N deferred-accepted)` when §3 *Accepted system-acceptance
deferrals* has N rows — the `pct` still counts each deferral as NOT-passed, so the
annotation explains the <100% shortfall rather than hiding it; (b) a dim
`by type: functional P/A · nfr/slo P/A · error-path P/A` sub-line joins §1.1 `Type`
to §2 status (only Types with ≥1 Active SYS-AC are shown).

**Section 2 — Worktree status.** For every `git worktree list --porcelain` entry,
overlay `<path>/.dev-state/state.json` if present and valid (`jq empty`). Render
`worktree path  task_id  phase  eval_round  DEFER  updated_at`, where **DEFER (3.6.0/K9)**
= `<Nf>f/<Ns>s`: `Nf` = `deferred_findings` length (K6), `Ns` =
`system_acceptance_deferred` length (K4) — both accepted-but-unverified gaps; `—` when
both zero. Counts are numeric `jq … | length` reads (never user strings → no sanitize).
Missing state.json → `(no /dev workflow)` with `—` placeholders. `null` fields normalised
to `—`.

**Section 3 — Task branches.** For every `git for-each-ref refs/heads/dev-task-*`
ref, render `branch  ahead  behind  dirty  worktree`. Ahead/behind computed via
`git rev-list --left-right --count <branch>...<per-branch-base>` where the
per-branch base is the owning worktree's `state.json.base_branch` (when present
and verified) or the script-level base chain (see §7.2). Foreign-base rows
annotate the WORKTREE cell with `(base: <name>)`. Stale flag = branch with no
worktree pairing renders `(stale — no worktree)`. Section 3 always emits a footer
disclaimer `(comparison base: <base> — local ref, not re-fetched; run \`git fetch
<remote>\` to refresh)` so operators know the data is local-cache state.

### 7.2 Read-only contract

`/dev board` does NOT:
- write `.dev-state/state.json` in any worktree;
- mutate git state (no `git fetch`, no `git checkout`, no `git worktree
  add/remove`, no `git branch -d`);
- invoke evaluator subagents or Codex (no network, no LLM calls);
- mutate MODULE docs, REQUIREMENTS_REGISTRY, or SYSTEM-ACCEPTANCE.md (read-only file open).

Exit code 0 on success even with empty sections; non-zero only on fatal git
errors (not inside a git repo).

**Hook-interaction note.** When `/dev board` is invoked while a `.dev-state/
state.json` exists in the current worktree (an active /dev workflow in plan /
docs / summary phase), the `check-phase.sh` PreToolUse hook restricts Bash to
its `READ_CMDS` allowlist; `bash` is not in that list. Result: the user is
prompted to approve the `bash plugins/dev/bin/board.sh` invocation once.
Approving is safe — the script is fully read-only by design — but the prompt
is documented here so operators expect it. To run with no prompt, invoke `/dev
board` from a worktree with no active /dev workflow (state.json absent → hook
returns "allow" at its early-exit gate).

**Base-branch resolution chain** (used as the script-level fallback when a
per-branch override is unavailable; mirrors `worktree-helper.sh new_cmd` so
behaviour does not diverge):
1. `state.json.base_branch` (current-cwd worktree's state.json) — reject on
   shell-metachar pre-check; otherwise verify via `git rev-parse --verify
   "$candidate^{commit}"` and use if it resolves.
2. `git symbolic-ref refs/remotes/origin/HEAD` stripped of remote prefix.
3. `main` (verify by `git rev-parse --verify refs/heads/main^{commit}`).
4. `master` (same verification).
5. Current branch via `git symbolic-ref --short HEAD` (guarded with `|| true`).
6. Unresolvable → footer renders
   `(comparison base: unresolved — detached HEAD and no main/master)`;
   ahead/behind cells show `?/?`.

### 7.3 Output rendering rules

- Tab-stop layout via `printf '%-Ns'` width specifiers (NOT actual tab characters).
- ANSI colour activated only when `[ -t 1 ]`; colour variables empty otherwise.
- **Colour + width interaction (mandatory pattern)**: `printf '%-Ns'` counts
  bytes, so ANSI escapes inside the padded segment shift alignment. The safe
  patterns:
  - Pad-then-wrap: `printf '%s%-Ns%s ' "$color" "$content" "$reset"` — escapes
    attach outside the count.
  - Manual padding: `printf '%s%s%s%*s' "$color" "$content" "$reset" "$pad" ""`
    where `pad = N - ${#content}`.
- Section 1 has two independent visual cues: the textual **Status column**
  (`Not Started` / `In Progress` / `Production` / `—`) and the **percentage
  colour band** (`≥85%` green, `70-84%` yellow, `<70%` red, `—` dim). They
  do not need to agree row-by-row — a "Production / green" or "In Progress /
  yellow" pair is the expected result, but partial progress can also produce
  e.g. "In Progress / red".
- Section 2 phase colours: plan/docs cyan; implement/audit/test/adversarial
  yellow; summary green; everything else uncoloured. **DEFER column (3.6.0/K9)**:
  yellow when any deferral (`Nf`/`Ns` > 0), dim `—` otherwise.
- Section 3: dirty `Y (N)` yellow, `N` plain, `?` dim; ahead > 0 green; behind
  > 0 yellow; stale rows in dim.

### 7.4 Sanitisation contract

Two distinct mechanisms (NOT one) handle externally-sourced strings.
Both reject **the same metachar set** — what differs is the action
(substitute vs reject) and the empty-string handling.

**Rejected metachar set (shared)**: any of `$`, backtick, `;`, `|`, `&`,
`\n`, `\r`, `\t`, `<`, `>`, `\033` (ESC — ANSI / terminal-injection
introducer), `\x7f` (DEL). The ESC + DEL additions are STRICTER than
the original `worktree-helper.sh list_cmd` `_sanitize` (which rejected
only the first 8 of the 12); board.sh extends the set because the board
also displays `base_branch` values which can carry ANSI escapes.

**`_sanitize` — display-substitution form**: used for display fields
whose provenance is partially trusted but where a malicious value
should not become copy-paste-runnable text: state.json values
(`task_id`/`phase`/`eval_round`/`updated_at`/`base_branch` when shown
as the per-branch `(base: X)` annotation), git ref names (the branch
list in Section 3), and module titles. Tainted values are replaced
with `?` and a stderr warning is emitted; the row is still printed so
operators retain visibility.

**`_is_safe_ref` — reject-on-metachar control-flow form**: used for any
value that flows into git invocations (`git rev-parse --verify`,
`git rev-list --left-right --count`) AND for any value used in the
Section 3 base-resolution chain. If the candidate hits the shared
metachar set above OR is empty → reject → the chain falls through to
the next fallback. Tainted values therefore NEVER reach git.

The footer disclaimer renders the resolved base name as-is (no
`?`-substitution) because every candidate that survives the
resolution chain in §7.2 — including step 5 (current branch via
`git symbolic-ref --short HEAD`), which is also gated by `_is_safe_ref`
in code — passed the safety check. This is safe by chain-design, not
by output-time sanitisation. Step 6 (unresolved) is the only path
where the footer prints a special-case literal string.

---
