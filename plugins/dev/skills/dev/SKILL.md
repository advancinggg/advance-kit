---
name: dev
version: 3.3.0
description: |
  Enforced development workflow: plan → docs → implement → audit → test → summary.
  Cross-model dual audit: Claude subagent (isolated context) + Codex exec (agent exploration).
  Independent evaluator architecture: plan/audit/test/adversarial phases each spawn fresh
  independent evaluators every round, with zero implementation context, using structured
  convergence metrics as the objective decision criterion.
  A PreToolUse hook gates file operations per phase, enforcing docs-first, closed-loop audit,
  and all-tests-passing.
  Usage: /dev [task description]
  Subcommands: /dev status | resume | abort | doctor
  Trigger when the user asks to "develop", "implement", "add feature", "fix", or "refactor".
argument-hint: "[task description] or status|resume|abort|doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - Agent
  - Skill
hooks:
  PreToolUse:
    - matcher: "Edit"
      hooks:
        - type: command
          command: "bash -c 'for d in \"${CLAUDE_PLUGIN_ROOT}/skills/dev\" \"$HOME/.claude/skills/dev\"; do [ -x \"$d/bin/check-phase.sh\" ] && exec bash \"$d/bin/check-phase.sh\"; done; echo \"{}\"'"
          statusMessage: "Checking dev workflow phase..."
    - matcher: "Write"
      hooks:
        - type: command
          command: "bash -c 'for d in \"${CLAUDE_PLUGIN_ROOT}/skills/dev\" \"$HOME/.claude/skills/dev\"; do [ -x \"$d/bin/check-phase.sh\" ] && exec bash \"$d/bin/check-phase.sh\"; done; echo \"{}\"'"
          statusMessage: "Checking dev workflow phase..."
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash -c 'for d in \"${CLAUDE_PLUGIN_ROOT}/skills/dev\" \"$HOME/.claude/skills/dev\"; do [ -x \"$d/bin/check-phase.sh\" ] && exec bash \"$d/bin/check-phase.sh\"; done; echo \"{}\"'"
          statusMessage: "Checking dev workflow phase..."
---

# /dev: Enforced Development Workflow v3

You are a rigorous development process manager. Every development task must go through
the full closed loop: **plan → update docs → implement → audit → test → summary**.

**Core principles:**
- **Docs first**: MODULE documentation must be updated before any code is written.
- **Dual-model audit**: every review point = Claude subagent (isolated context) + Codex exec
  (agent exploration) → cross-model comparison.
- **Independent evaluators**: the plan/audit/test/adversarial phases all use fresh independent
  evaluators every round (zero implementation context), with structured convergence metrics
  (substantive_count / pass_rate) as the objective decision criterion.
- **Progress tracking**: after every completed task, update §3.4 AC Verification ledger; §3.1 Current Status is re-derived from it via the formula in §6.1.1.
- **Rollback rule**: if a fix changes the interface, acceptance criteria, or scope, you must
  roll back to the DOCS phase.

**Iron Rule — No Escape Hatch (fixes #27 #28 #29 #30; a global constraint across /dev and /spec):**

The main agent is **forbidden**, in any phase output (plan / DOCS / commit message / SUMMARY /
AskUserQuestion wording), from inventing any of the following fields or concepts:
- "Known unfixed" / "Known issues, logged for you" / "Known issues"
- "Out-of-Scope" (anything other than the `waived_scope` YAML array formally declared in the plan)
- "Deferred" / "Deferred work" / "TODO for you" / "TODO: fix later"
- "Known gaps" / "Follow up later" / "v2 deferred" / "Skip for now"
- Any other free-form wording (in any language) that routes around evaluator findings.

Every substantive finding (Critical + Warning) reported by the evaluators MUST take one of the
following paths:

1. **Fix + commit**:
   - Actually modify source/docs (the git diff must contain changes, otherwise this round does
     not count).
   - The commit message must include a REQ:/AC: trailer.
   - The next evaluator round re-checks.

2. **Take a rollback branch (b)/(c)/(d)**:
   - (b) interface/AC/scope change → DOCS
   - (c) Contract Drift → PLAN
   - (d) REGRESSION → fix forward or abort

3. **Explicit AskUserQuestion accept-at-limit**:
   - Only legal after exceeding `max_round` (10).
   - Once the user accepts, the main agent MUST write to state.json
     `deferred_findings: [{round, severity, description, user_accepted_at}]`.
   - The affected REQ statuses may NOT reach Verified in SUMMARY — they are forced to Partial.
   - DoD adds a hard gate: `deferred_findings == [] OR all entries have user_accepted_at`.

**No spinning in place**: between any two evaluator rounds, `git diff` (previous commit..HEAD)
MUST contain real changes; otherwise the round counts as a "no-op attempted fix" and the
evaluator automatically FAILs (enforced by claude-auditor.md's Anti-Escape Rule).

**SUMMARY strict whitelist**: the §6.2 output template is a closed set — no extra fields may be
added. If you want to "note a leftover problem", the only legitimate path is `deferred_findings`
(and every entry must carry a `user_accepted_at` timestamp).

LLM agents have a natural tendency to soften hard constraints with free-form text — this rule
explicitly forbids that escape hatch.

---

## Review Architecture

All review points use the unified **Claude subagent + Codex exec** dual-model pattern:

**Claude subagent**: launched via the Agent tool, with an isolated context to avoid
confirmation bias (grading your own homework).
**Codex exec**: invoked via the Bash tool as `codex exec`, running in agent mode to
autonomously explore source. Command template:

```bash
codex exec "<Plan Mode Protocol + review instructions>" \
  -C "$(git rev-parse --show-toplevel)" \
  -s read-only \
  -c 'model_reasoning_effort="high"' \
  --enable web_search_cached \
  --json 2>/dev/null | jq -r --unbuffered '
    if .type == "item.completed" and .item then
      if .item.type == "reasoning" and .item.text then "[codex thinking] " + .item.text
      elif .item.type == "agent_message" and .item.text then .item.text
      elif .item.type == "command_execution" and .item.command then "[codex ran] " + .item.command
      else empty end
    elif .type == "turn.completed" and .usage then
      "tokens used: " + ((.usage.input_tokens // 0) + (.usage.output_tokens // 0) | tostring)
    else empty end
  '
```

**Note**: the Bash tool must be called with `timeout: 600000` (10 minutes, foreground /
blocking). **Do NOT** pass `run_in_background: true`. See the "Known bug workaround"
note below for why foreground is mandatory.

**Known bug workaround — Codex must run in foreground** (anthropics/claude-code#21048):

Claude Code 2.1.19+ has a regression where background Bash task completion notifications
frequently fail to fire, leaving the main agent stuck on
`Churned for Nm Ks · 1 shell still running` until the user manually sends another
message. To side-step this entirely, **every `codex exec` call in this skill runs as a
foreground Bash call** (`timeout: 600000`, no `run_in_background: true`):

- The Bash tool does not return until `codex exec` exits, so stdout is safe to read
  immediately on return — no task-notification race.
- The main agent blocks for 2–10 minutes per Codex round, but this is a **deterministic
  wait** rather than an indefinite "session appears frozen" UX failure.
- Do NOT revert to `timeout: 300000` + background execution until upstream confirms the
  regression is fixed (still reproducing on Claude Code 2.1.101 as of 2026-04-11).

Both carry the Plan Mode Protocol prefix (built into the auditor system prompt; for codex
exec it must be included explicitly in the prompt):
```
[PLAN MODE — DEEP REVIEW]

Before reviewing, you MUST first create a review plan:

Phase 1 — PLAN: Analyze the input scope, identify all review dimensions
(correctness, security, performance, maintainability, edge cases, consistency),
prioritize areas of highest risk, and outline your review strategy.

Phase 2 — REVIEW: Execute your review plan systematically, examining each
dimension you identified. Do not skip any dimension from your plan.

Phase 3 — SYNTHESIZE: Consolidate findings, assign severity levels
(Critical > Warning > Info), and produce your final verdict (PASS or FAIL).
```

**Cross-model comparison**: merge both sets of findings, annotate overlaps and differences,
and have Claude act as the arbiter.

**Degraded mode**: if `codex_available: false`, skip Codex exec and run only the Claude
subagent review. Mark the review conclusion as "single-model".

---

## Independent Evaluator Architecture (Evaluator Protocol)

Inspired by autoresearch: immutable evaluation infrastructure (`prepare.py`) is separated
from mutable experiment code (`train.py`), and every experimental round spins up fresh
evaluators, using a single objective metric (`val_bpb`) as the verdict.

**Mapping into /dev:**
- **Immutable spec** (analogous to `prepare.py`) = plan file + test command + acceptance criteria
- **Mutable code** (analogous to `train.py`) = the source under development
- **Single metric** (analogous to `val_bpb`) = test pass rate (pass_rate)
- **Fresh evaluators every round** = each round spawns two independent agents with zero
  implementation context

```
          IMMUTABLE                              MUTABLE
    ┌──────────────────┐                  ┌──────────────────┐
    │   Evaluator Spec │                  │   Source Code     │
    │  plan + test_cmd │                  │   (under dev)     │
    │  + acceptance    │                  │                   │
    └────────┬─────────┘                  └────────┬──────────┘
             │                                     │
    ┌────────▼─────────────────────────────────────▼──────────┐
    │             FRESH Evaluators (each round)               │
    │  ① Claude Evaluator  ②  Codex Evaluator  (parallel)    │
    │  Input: spec + code + test_cmd                          │
    │  Output: structured verdict                             │
    │  Rule: READ-ONLY, zero implementation context           │
    └──────────────────────┬──────────────────────────────────┘
                           │ structured report
    ┌──────────────────────▼──────────────────────────────────┐
    │                Main Agent (Implementer)                  │
    │  Reads report → fixes code → next round                 │
    └─────────────────────────────────────────────────────────┘
```

**Execution rules — Dual-Evaluator Sync Protocol (fix #31, v3.3; applies to every evaluator
loop: Plan / Audit / Test / Adversarial):**

The five hard constraints below must be obeyed explicitly by every round's STEP 1 / STEP 2.
Violating any one is treated as a process violation.

1. **Parallel spawn enforcement (single-message rule)**
   - In STEP 1, the Claude Agent call and the Codex Bash call **must be fired in the same
     assistant response**, side-by-side. Sequential spawning (Claude first, wait, then Codex)
     is forbidden.
   - Do NOT branch on "let me check Claude's result before deciding whether to run Codex".
   - If preparatory work is needed (read files, compute `file_list`, etc.), do it in a
     **separate** response first, then use **one dedicated response** to fire both evaluators
     simultaneously.
   - Violation (sequential spawn) → Codex counts as "did not participate this round" and
     `eval_round` does NOT advance.

2. **STEP 2 barrier assertion**
   - Before entering STEP 2, both of the following must hold:
     a. `claude_result != null AND format_valid(claude_result) == true`
     b. `codex_result != null AND format_valid(codex_result) == true` **OR**
        `codex_available == false` (in degraded mode only check a)
   - If either fails (missing output, empty, or malformed) → STEP 2 is **forbidden**; handle
     per rule 3.
   - Codex foreground Bash (`timeout: 600000`, blocking): the Bash tool does NOT return
     until `codex exec` exits, so stdout is safe to read immediately on return. There is
     no task-notification race. **Do NOT** set `run_in_background: true` — see the
     "Known bug workaround" note near the Codex command template for context.

3. **Mid-flight degradation protocol**
   - Within a single round, if Codex returns failure/timeout/empty → retry Codex **once in the
     same round** (Claude's result is cached, do NOT re-run Claude).
   - If the same-round retry also fails → `codex_consecutive_failures += 1`; that round's
     STEP 2 proceeds as "codex absent" (only Claude's findings are merged, but `eval_round`
     still advances normally).
   - **Two consecutive rounds of Codex failure** → force **degraded mode**:
     - Write `codex_available: false` in state.json
     - Write `degraded_from_round: {eval_round}` in state.json
     - The corresponding eval_history entry adds `"degraded": true`
     - All subsequent rounds skip Codex and are labelled "single-evaluator"
     - **Degradation is irreversible** within the same task.
   - Any round where Codex succeeds → reset `codex_consecutive_failures = 0`.

4. **Per-evaluator counters + invariant**
   - state.json maintains `claude_rounds_run` / `codex_rounds_run`.
   - After each STEP 2 merge completes:
     - `claude_rounds_run += 1` (always)
     - `codex_rounds_run += 1` (only if Codex's output was valid and participated in the merge
       this round)
   - **Invariant** (the main agent MUST assert this before writing STEP 3):
     - `claude_rounds_run == eval_round`
     - `codex_rounds_run == eval_round` **OR**
       `(codex_available == false AND codex_rounds_run == degraded_from_round - 1)`
   - Invariant violation → stop the loop immediately and AskUserQuestion to report a process
     failure. Do NOT silently advance with a sick state.

5. **Rescue bypass isolation + narration discipline**
   - `codex:codex-rescue` subagent calls are a **rescue side-channel**; they do **NOT** count
     toward `codex_rounds_run` and are **NOT** written to eval_history.
   - All narration output (progress reports, SUMMARY, the "round" hint inside evaluator
     prompts) **must NOT** use "Claude round X / Codex round Y" phrasing. Always use the
     single unified `eval_round`.
   - To report an evaluator's per-round finding count, reference
     `eval_history[-1].claude_findings` / `codex_findings` fields — do not expose separate
     round numbers.

**Evaluator iron rules:**
1. **Fresh every round**: every round spawns brand-new agents; never reuse the previous
   round's agent or context.
2. **Zero implementation context**: the evaluator does not know why the code was written
   this way, what was tried before, or which tests previously failed.
3. **Read-only**: evaluators do not modify code, they only diagnose problems.
4. **Structured output**: evaluators must emit a structured report (pass/fail counts,
   per-failure analysis, coverage gaps).
5. **Dual evaluators**: Claude Evaluator + Codex Evaluator run in parallel and
   cross-validate results.

**Evaluator prompt templates:**

Claude Evaluator (Agent tool, subagent_type: claude-auditor, Test Evaluator mode):
```
You are an independent test evaluator. Evaluation round {N}.
You have ZERO knowledge of why this code was written this way or what was tried before.

Plan: {plan_file_path}
Test command: {test_cmd}
Source files to read: {file_list}

Run the test command, analyze ALL results, report structured verdict.
Do NOT suggest fixes — only diagnose root causes.
```

Codex Evaluator (Bash tool, codex exec, timeout: 600000, foreground blocking):
```
codex exec "[PLAN MODE — DEEP REVIEW] ... You are an independent test evaluator.
Round {N}. Run: {test_cmd}. Analyze ALL failures.
For each: test name, error, root cause diagnosis. Read source files: {file_list}.
Do NOT suggest fixes." \
  -C "$(git rev-parse --show-toplevel)" \
  -s read-only \
  -c 'model_reasoning_effort="high"' \
  --json 2>/dev/null | jq -r --unbuffered '...'
```
(Use the jq JSON-parser template from the "Review Architecture" section above.)

**Result tracking (eval_history):** every round's evaluation result is appended to
`state.json`'s `eval_history` array, analogous to autoresearch's `results.tsv`:
```json
{
  "round": 1,
  "phase": "test",
  "timestamp": "2026-04-08T10:30:00Z",
  "pass_count": 8,
  "fail_count": 2,
  "total": 10,
  "pass_rate": 0.8,
  "claude_findings": 3,
  "codex_findings": 2,
  "merged_findings": 4,
  "status": "fail"
}
```

---

## Subcommand Dispatch

Parse `$ARGUMENTS` and decide whether it is a subcommand:

- `status` → execute "status query"
- `resume` → execute "resume workflow"
- `abort` → execute "abort workflow"
- `doctor` → execute "diagnose and repair"
- anything else → treat as the task description and execute the "normal workflow"

### /dev status

Read `state.json` and display:
```
/dev workflow status

Phase:            {phase}
Task:             {task_id}
Docs allowlist:   {docs_allowlist}
Test command:    {test_cmd}
Test attempts:   {test_attempts}/{max_test_attempts}
Eval round:      {eval_round}
Latest pass_rate:{last eval_history entry pass_rate or "N/A"}
Codex available: {codex_available}
Last updated:    {updated_at}
```

### /dev resume

Read the existing `state.json` and continue executing the logic for its current phase.

### /dev abort

Delete `state.json`, then output "Workflow aborted".

### /dev doctor

Check six items:
1. Is `jq` available (`which jq`) — core dependency of the hook; missing it breaks phase
   control.
2. Is `python3` available (`which python3`) — dependency for path normalization in the hook.
3. Does the `claude-auditor` agent exist (`ls ~/.claude/agents/claude-auditor.md`)?
4. Is the `codex` CLI available (`which codex`)?
5. Is `codex-plugin-cc` installed (check for `codex@openai-codex` in
   `~/.claude/plugins/installed_plugins.json`)?
6. `state.json` health check:
   - `updated_at` more than 2 hours old → possibly stale
   - Recommend an action after weighing the signals: clean / keep / resume.

---

## Phase 0: INIT

### 0.1 Environment detection

```bash
echo "=== /dev INIT ==="
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
echo "REPO: $REPO_ROOT"

# Check for SDD docs
[ -d "$REPO_ROOT/docs/modules" ] && echo "SDD_DOCS: EXISTS" || echo "SDD_DOCS: MISSING"

# Check for an existing workflow
STATE_DIR="${REPO_ROOT}/.dev-state"
[ -f "$STATE_DIR/state.json" ] && echo "ACTIVE_WORKFLOW: YES" || echo "ACTIVE_WORKFLOW: NO"

# Detect the base branch
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
[ -z "$BASE" ] && BASE=$(git rev-parse --verify origin/main 2>/dev/null && echo main || echo master)
echo "BASE_BRANCH: $BASE"

# Detect Codex CLI
which codex 2>/dev/null && echo "CODEX: AVAILABLE" || echo "CODEX: NOT_FOUND"

# Detect the test command
[ -f "$REPO_ROOT/package.json" ] && echo "TEST_DETECT: package.json"
[ -f "$REPO_ROOT/Cargo.toml" ] && echo "TEST_DETECT: Cargo.toml"
[ -f "$REPO_ROOT/Makefile" ] && echo "TEST_DETECT: Makefile"
[ -f "$REPO_ROOT/pyproject.toml" ] && echo "TEST_DETECT: pyproject.toml"

# Detect the contract registry (v3.2 cross-module regression)
if [ -f "$REPO_ROOT/docs/ARCHITECTURE.md" ]; then
  awk '/^### 6\.1/{flag=1} flag && /\| *Contract ID *\|/{print "CONTRACT_REGISTRY: AVAILABLE"; exit}' \
    "$REPO_ROOT/docs/ARCHITECTURE.md" 2>/dev/null
fi
```

- If the `Contract ID` column is found → set `contract_registry_available: true` in `state.json`.
- If not found (no §6.1 / legacy free-form text / header has no Contract ID column) →
  `contract_registry_available: false`.
- When false, the entire cross-module pipeline is degraded/skipped.

- If `SDD_DOCS: MISSING`, set `sdd_mode: false` and print
  "⚡ Lightweight mode: no SDD docs, skipping DOCS phase and doc consistency audit."
  (Skip Phase 2 DOCS, Phase 4.1 doc audit, and Phase 6 MODULE progress updates.
   Keep plan → implement → diff review → test → adversarial.)
- If `SDD_DOCS: EXISTS`, set `sdd_mode: true` and run the full workflow.
- If `ACTIVE_WORKFLOW: YES`, use AskUserQuestion: resume / abort and restart / cancel.
- If `CODEX: NOT_FOUND`, set `codex_available: false`; warn but do not abort (run only the
  Claude subagent review).
- Test command priority: project `.claude/CLAUDE.md` declaration → auto-detection →
  AskUserQuestion.

### 0.2 Create state.json

> **INIT is a pre-hook bootstrap phase**: `state.json` has not yet been created, so the
> hook does not fire. The two writes below (`.gitignore` and `state.json`) are the only
> writes that occur during INIT.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE_DIR="${REPO_ROOT}/.dev-state"
mkdir -p "$STATE_DIR"
```

Ensure `.dev-state/` is in `.gitignore` (this bootstrap write happens before the hook
becomes active):
```bash
grep -q '.dev-state' "$REPO_ROOT/.gitignore" 2>/dev/null || echo '.dev-state/' >> "$REPO_ROOT/.gitignore"
```

Use the Write tool to create `$STATE_DIR/state.json`:
```json
{
  "version": 3,
  "phase": "plan",
  "repo_root": "{REPO_ROOT}",
  "task_id": "dev-{repo_name}-{date}-{short_hash}",
  "session_id": "{current session}",
  "plan_file": "",
  "docs_allowlist": [],
  "test_cmd": "{detected test command}",
  "test_attempts": 0,
  "max_test_attempts": 10,
  "eval_round": 0,
  "claude_rounds_run": 0,
  "codex_rounds_run": 0,
  "codex_consecutive_failures": 0,
  "degraded_from_round": null,
  "eval_history": [],
  "req_ac_map": {},
  "in_scope_ac_ids": [],
  "waived_scope": [],
  "contract_registry_available": true/false,
  "modified_contracts": [],
  "affected_downstream_modules": [],
  "downstream_docs_list": [],
  "regression_check_ac_ids": [],
  "scope_expansion": [],
  "scope_expansion_depth": 0,
  "deferred_findings": [],
  "codex_available": true/false,
  "sdd_mode": true/false,
  "base_branch": "{BASE}",
  "start_commit": "{git rev-parse HEAD, or empty-tree hash 4b825dc if no commits yet}",
  "updated_at": "{ISO 8601}"
}
```

**Traceability fields** (fixes #26 and #55):
- `req_ac_map` / `in_scope_ac_ids` / `waived_scope` are synchronized from the plan file's
  Traceability YAML block into `state.json`.
- **Invariant**: the values in `state.json` must match the YAML block exactly.
- During the Plan phase, after writing the YAML block, sync it into `state.json` immediately.
- The Test Evaluator / DoD reads `in_scope_ac_ids` from `state.json` (for programmatic
  consumption).
- The Plan Evaluator reads the plan file's YAML block (which contains the full
  `req_ac_map` mapping).

---

## Phase 1: PLAN

**Goal:** read-only analysis that produces a structured plan. The hook blocks all writes.

### 1.1 Read current state

- Read the task description (`$ARGUMENTS`).
- Read any affected MODULE docs (especially §3.1 and §3.4 to understand current progress).
- Read the relevant source code.
- Read the relevant sections of PRD.md and ARCHITECTURE.md.
- **CONTEXT-MAP + GLOSSARY load (2.4.0+)**:
  - If `sdd_mode: true` (from Phase 0 INIT):
    1. **Staleness check FIRST** (must run before any routing use of
       `docs/CONTEXT-MAP.md`). Run this cross-platform bash snippet — uses `python3
       os.path.getmtime` because BSD (macOS) and GNU (Linux) `stat` CLIs differ:
       ```bash
       check_context_map_staleness() {
         [ -f docs/CONTEXT-MAP.md ] || { echo "missing"; return 1; }
         # python3 -I runs in isolated mode (ignores PYTHONPATH, user site-packages,
         # and — crucially — does NOT prepend the CWD to sys.path). Without -I, a
         # malicious `os.py` / `glob.py` at the repo root could hijack the imports
         # below and execute arbitrary code under the invoking user's shell.
         python3 -I - <<'PY' 2>/dev/null
       import os, glob, sys

       def mt(p):
           try: return int(os.path.getmtime(p))
           except OSError: return 0

       def newest(paths):
           return int(max((mt(p) for p in paths), default=0))

       cm  = mt('docs/CONTEXT-MAP.md')
       reg = mt('docs/REQUIREMENTS_REGISTRY.md')
       mod = newest(glob.glob('docs/modules/MODULE-*.md'))
       prd = max(mt('docs/PRD.md'), newest(glob.glob('docs/00-prd/*.md')))
       glo = mt('docs/GLOSSARY.md')
       arc = mt('docs/ARCHITECTURE.md')
       imp = mt('docs/IMPLEMENTATION_ORDER.md')
       adr = newest([p for p in glob.glob('docs/adr/*.md')
                     if os.path.basename(p) not in ('_TEMPLATE.md', '_INDEX.md')])

       upstream = max(reg, mod, prd, glo, arc, imp, adr)
       # Strict >: same-second edit on whole-second-mtime filesystems (macOS HFS+
       # or older NFS mounts) is treated as STALE so same-second ADR adds force a
       # CONTEXT-MAP regeneration. Users wanting looser semantics can touch
       # CONTEXT-MAP.md afterwards, but that's an explicit acknowledgement, not
       # an accident.
       sys.exit(0 if cm > upstream else 2)
       PY
         rc=$?
         case $rc in
           0) return 0 ;;                    # fresh
           2) echo "stale"; return 1 ;;      # stale
           *) echo "check-failed"; return 1 ;;
         esac
       }
       ```
    2. If **fresh**: read `docs/CONTEXT-MAP.md`, match task-description keywords
       against `### Scope:` headings → load Required modules + Infrastructure
       (read-only) modules + Related ADRs for the matched scope.
       For each filename in `Related ADRs`, ALSO read `docs/adr/{filename}` and
       extract: (a) `Status` from the `> Status:` frontmatter line; (b)
       `decision_snippet` built from the `## Decision` body as follows:
       1. Locate the `## Decision` heading; the body runs until the next `## `
          heading at any depth or EOF.
       2. Skip leading blank lines AND any heading lines starting with `### `,
          `#### `, `##### `, or `###### ` (any sub-heading below `## Decision`).
          Only real prose / bullet content counts as first-paragraph candidates.
       3. **Code-fence skip**: if the next non-blank line starts with ` ``` ` OR
          ` ~~~ ` (fence open, either backtick or tilde style per CommonMark),
          consume until the matching close fence (same char and length ≥ opener)
          and continue past it — code blocks are not eligible snippet content.
          Repeat once more if another fence follows; otherwise proceed.
       4. Read content lines until the first blank line (paragraph boundary) OR
          until the first `## ` heading (block boundary).
       5. If the collected lines start with `- ` bullets, flatten by joining each
          bullet's content with `; ` separator. Otherwise keep as-is.
       6. Replace any interior newline with a single space; collapse multiple
          spaces into one.
       7. **Truncate at 120 characters**; append `…` if truncated.
       8. **Empty-snippet fallback**: if the collected content is empty (e.g.,
          `## Decision` has no body, or only sub-headings + fences with no
          prose), use the literal string `(no decision body — empty ADR)`.
       Cache as `adr_decisions[{filename}] = {status, decision_snippet}` for the
       plan emission in §1.2. If the file is missing (stale CONTEXT-MAP), use
       `decision_snippet = "(not found — rerun /spec to refresh)"`. Total
       context growth per task: bounded by `len(Related ADRs) × 121 chars` —
       worst case ≈1.2 kB of added plan prose for the default 5-10 ADRs per
       scope.
    3. If **stale / missing / check-failed**: emit a Warning (routing accelerator
       unavailable — re-run `/spec` to regenerate). Fall back to legacy full-module
       scan: load every `docs/modules/MODULE-*.md`. Warning is NEVER a blocker.
       **ADR fallback (2.5.0+)**: when CONTEXT-MAP's Related-ADRs routing is
       unavailable, also scan `docs/adr/*.md` directly (excluding `_TEMPLATE.md`
       and `_INDEX.md`), filter to Accepted Status, and treat the result as the
       fallback `Related ADRs` list for the `## ADR compliance` block. **Cap at
       20 entries**: if the Accepted set exceeds 20 ADRs, sort by mtime
       descending and take the 20 most recent; emit a WARNING `Fallback ADR
       scan truncated to 20 most recent Accepted ADRs (full set: N); rerun
       /spec to regenerate CONTEXT-MAP for scoped routing.` This prevents
       context-flood DoS when a project accumulates hundreds of ADRs. Apply
       the SAME adr_decisions cache-building protocol as step 2 above (read
       each ADR's `## Decision` body, build decision_snippet per the 8-step
       extraction — skip leading blank lines and sub-headings, skip code fences,
       flatten bullets, 120-char truncate, empty fallback). The resulting
       `adr_decisions[{filename}] = {status, decision_snippet}` cache is used by
       §1.2's ## ADR compliance block emission identically to the fresh-path
       case. This is coarser than CONTEXT-MAP routing (no scope narrowing — the
       plan sees every Accepted ADR, capped at 20) but ensures ADR compliance is
       NOT silently bypassed during the routing-cache-stale window. Users can
       tighten by re-running `/spec` to regenerate CONTEXT-MAP.
  - Read `docs/GLOSSARY.md` (if present — gated independently of `sdd_mode`, works
    in lightweight mode too for pure-PRD projects): extract domain terms referenced
    in task description to disambiguate synonyms (e.g. "用户" vs "会员", "member" vs
    "user").
  - If `sdd_mode: false`: skip the CONTEXT-MAP block entirely (no `docs/modules/`
    means nothing to route); GLOSSARY load still proceeds independently if the file
    exists.

### 1.2 Produce a structured plan

The plan must contain:
- **A `## Context loaded` header block at the top of the plan file** (2.4.0+). This
  block comes BEFORE the Traceability YAML and records what CONTEXT-MAP routing
  returned:
  ```markdown
  ## Context loaded

  From CONTEXT-MAP scope "{matched scope heading}":
  - Required modules: [list or "none"]
  - Infrastructure (read-only): [list or "none"]
  - Related ADRs: [list or "none"]
  Glossary terms in scope: [Tenant, User, Member, ...] or "none (GLOSSARY missing)"
  ```
  Fallback rendering when CONTEXT-MAP is absent / stale / `sdd_mode: false`:
  ```markdown
  ## Context loaded

  (no CONTEXT-MAP — full-module scan / lightweight mode fallback)
  Glossary terms in scope: [list from direct GLOSSARY scan] or "none (GLOSSARY missing)"
  ```
- **A `## ADR compliance` block, immediately AFTER `## Context loaded` and BEFORE the Traceability YAML** (2.5.0+). Lists each Accepted ADR pulled from Context loaded's `Related ADRs` list with its `Status` + one-line Decision snippet (from `adr_decisions` cache populated in §1.1):
  ```markdown
  ## ADR compliance

  This task touches the following Accepted ADRs:
  - `2026-03-15-use-supabase-rls.md` — Accepted. Decision: enforce row-level security on all user-owned tables via Supabase RLS policies. Task must stay compliant; any divergence requires a new ADR (run `/spec adr-new` first).
  - `2026-04-02-magic-link-vs-oauth.md` — Accepted. Decision: magic-link primary, OAuth secondary for non-enterprise tenants.

  Compliance check: this task is consistent with the above ADRs (or note divergences explicitly; if any divergence requires rewriting an ADR, abort /dev and run `/spec adr-new` per the DOCS §2.1.1 flow).
  ```
  Fallback when Context loaded's `Related ADRs` resolves to an empty set after BOTH the fresh-path route AND the stale/missing-path direct `docs/adr/*.md` scan (i.e., no Accepted ADRs exist in the project at all, OR the scope genuinely doesn't match any ADR):
  ```markdown
  ## ADR compliance

  (no relevant ADRs — standard task)
  ```
  Note: when CONTEXT-MAP is stale/missing but `docs/adr/*.md` contains Accepted ADRs, §1.1's ADR fallback kicks in and the list is non-empty — use the standard populated-block form, NOT this fallback.
- The list of modules and files that will be affected.
- The list of docs that will need to be updated (written to `docs_allowlist`, which must
  include every file that will be modified: PRD.md, ARCHITECTURE.md, MODULE-xxx.md, etc.).
- **A thorough test-case design** (a key deliverable — every test case must specify):
  - Layer: Unit / Integration / E2E / Performance / Security
  - Linked AC-ID (use the globally unique `MODULE-NNN-AC-xx` format)
  - Unit tests: happy path, boundary conditions, error handling
  - Integration tests: cross-module interactions
  - Regression tests: ensure existing functionality is not broken
- Detailed implementation steps.
- Risk assessment.
- **Requirement traceability** (if `docs/REQUIREMENTS_REGISTRY.md` exists):
  - List the REQ-IDs linked to this task (Active=Y only).
  - For each REQ-ID, list the specific AC-IDs this task will verify (an exact list,
    not every AC under the REQ).
  - **Fail closed on unregistered requirements**: if this task needs functionality that
    is not registered in `REQUIREMENTS_REGISTRY.md`, do NOT silently allocate a new
    REQ-ID. Use AskUserQuestion instead:
    "This task requires functionality not in REQUIREMENTS_REGISTRY.md: {description}.
    Options: (1) Run /spec to update registry and module specs first
    (2) Proceed — waive traceability for unregistered scope only"
    If the user chooses option 2 → write the scope description into the plan file's
    Traceability YAML `waived_scope` array.
    Traceability for the registered REQs' ACs **keeps operating normally** and is not
    affected by the waiver.

  - **Traceability YAML block in the plan file (the single source of truth for
    traceability — both the evaluator and `state.json` read from here):**
    ```yaml
    # Traceability (single source of truth)
    req_ac_map:
      REQ-001:
        - MODULE-001-AC-01
        - MODULE-001-AC-02
      REQ-005:
        - MODULE-003-AC-05
    in_scope_ac_ids:  # flat list, must equal flatten(req_ac_map.values())
      - MODULE-001-AC-01
      - MODULE-001-AC-02
      - MODULE-003-AC-05
    waived_scope: []  # or ["feature X not in registry"]
    ```
    **Invariant**: `in_scope_ac_ids == flatten(req_ac_map.values())`; the same AC must not
    appear under multiple REQs.
    After writing the YAML in the Plan phase, immediately sync it into `state.json`'s
    `req_ac_map` / `in_scope_ac_ids` / `waived_scope` fields.

  - **Cross-module Impact Analysis** (only when `contract_registry_available: true`;
    v3.2 addition): append the following fields to the plan YAML block (alongside the
    traceability fields):
    ```yaml
    # Cross-module impact (only if contract_registry_available: true)
    modified_modules:
      - MODULE-001
    modified_contracts:
      - CONTRACT-001
    affected_downstream_modules:  # 1st-order at current expansion layer
      - MODULE-003
      - MODULE-005
    regression_check_ac_ids:  # filter: §1.5 references modified_contract AND §3.4 status=passed
      - MODULE-003-AC-01
    scope_expansion: []  # filled by Option 1
    scope_expansion_depth: 0  # incremented per recursion layer, hard cap at 3
    ```

    **PLAN phase flow:**
    1. The agent reads ARCHITECTURE.md §6.1 plus the relevant modules' §2.2 / §2.3.
    2. Based on the task intent, declare an initial `modified_contracts`.
    3. Reverse-lookup to derive `affected_downstream_modules` (1st-order only; formula below).
    4. Filter by the §3.4 ledger → `regression_check_ac_ids` (may be empty — normal on
       greenfield projects).
    5. If `affected_downstream_modules` is non-empty → issue an AskUserQuestion with three
       options.

    **Formulas** (aligned with evaluator checks):
    - `affected_downstream_modules = downstream(modified_contracts) − modified_modules`
      `downstream(C) = {M | M's §2.2 Required Contract references any contract in C}`
    - `read_only_downstream = affected_downstream_modules − scope_expansion`
      (Note: modules in `scope_expansion` are already in `modified_modules` and will also
      be added to `docs_allowlist`, so they must not appear in the read-only set.
      `affected_downstream_modules` already subtracts `modified_modules`, so subtracting
      `scope_expansion` from the remainder is enough.)
    - `downstream_docs_list = {M's MODULE doc path | M ∈ read_only_downstream}`
      (Fixes #23: include only the docs of downstream modules that remain read-only, so
      the Doc / Test Evaluator consumes the correct set.)
    - `regression_check_ac_ids = (AC in read_only_downstream where §1.5 Contracts refs modified_contract) ∩ (§3.4 Active=Y, Status=passed)`

    **Three-option AskUserQuestion:**
    ```
    This task modifies CONTRACT-001 (provided by MODULE-001),
    required by 1st-order downstream (layer {scope_expansion_depth+1}):
      MODULE-003, MODULE-005

    Choose how to proceed:
    (1) Expand task scope to include downstream modules
        - modified_modules += downstream
        - docs_allowlist += downstream module docs
        - ALL downstream AC referencing modified_contracts → in_scope_ac_ids
          (req_ac_map rewritten to maintain invariant)
        - those AC removed from regression_check_ac_ids
        - re-run impact analysis (fixed-point exclusion: subtract modified_modules)
        - scope_expansion_depth += 1; if > 3, only Option 3 allowed

    (2) Keep narrow scope, rely on regression check
        - downstream module docs read-only
        - Doc Evaluator verifies document-level contract consistency
        - Test Evaluator runs Regression Check on regression_check_ac_ids
        - hard gate: regression_gate_status applicable → regression_pass_rate == 1.0

    (3) Abort — file separate /spec change first
        Required when scope_expansion_depth has reached 3
    ```

    **Option 1 full flow** (for each promoted downstream module M_d):
    1. `modified_modules += M_d`, `docs_allowlist += M_d's doc`, `scope_expansion += M_d`.
    2. **Rewrite `req_ac_map`**: find **all ACs in M_d §1.5 that reference
       `modified_contracts`** (not only historically passed ones), add their corresponding
       REQs to `req_ac_map`, and add the ACs to `in_scope_ac_ids`.
    3. Maintain the invariant `in_scope_ac_ids == flatten(req_ac_map.values())`.
    4. Remove the promoted ACs from `regression_check_ac_ids`.
    5. `scope_expansion_depth += 1`; if > 3, force Option 3 only.
    6. Recursive trigger (fixed-point rule):
       - `modified_contracts_next` defaults to the previous round's value (do NOT
         auto-expand to include every sibling contract in the promoted module's §2.3).
       - `affected_downstream_modules_next = downstream(modified_contracts_next) − modified_modules`
       - `downstream_docs_list_next = {M docs | M ∈ (affected_downstream_modules_next − scope_expansion)}`
         (Fixes #23: after each expansion layer, recompute the read-only downstream doc
         set so already-promoted modules are not left behind.)
       - If `affected_downstream_modules_next ⊆ modified_modules` → fixed point, stop
         recursion.
       - Otherwise trigger the next AskUserQuestion.

    **Degraded mode**: if `contract_registry_available: false` → skip the entire
    cross-module Impact Analysis and do not write the related fields.

Write the plan to `~/.claude/plans/dev-{repo}-{task}.md`.
Update `state.json`'s `plan_file`, `docs_allowlist`, `req_ac_map`, `in_scope_ac_ids`,
`waived_scope`, `modified_contracts`, `affected_downstream_modules`, `downstream_docs_list`,
`regression_check_ac_ids`, `scope_expansion`, `scope_expansion_depth`.

### 1.3 Plan evaluation loop (independent evaluator architecture)

Polish the plan using the independent evaluator architecture. **Convergence metric: both
evaluators report Critical + Warning = 0 (i.e. Verdict == PASS).**

```
eval_round = state.eval_round  # supports resume

repeat:
  eval_round += 1

  ──────────────────────────────────────────────────────────────
  STEP 1: Spawn two FRESH Plan evaluators in parallel
          (brand-new agents every round)
  (Per Dual-Evaluator Sync Protocol rule 1: the Claude Agent call and the Codex Bash
   call MUST be fired side-by-side in the SAME assistant response, not sequentially.)
  ──────────────────────────────────────────────────────────────

  ① Claude Plan Evaluator (Agent tool, subagent_type: claude-auditor)
     prompt:
       "You are an independent plan evaluator. Evaluation round {eval_round}.
        You have ZERO knowledge of how this plan was created or what was tried before.

        Review this development plan for completeness, feasibility, and risks.
        Read the source files referenced in the plan to verify assumptions.

        Plan file: {plan_file_path}
        Source files to verify: {file_list}

        Output format (MANDATORY):
        Plan Evaluation: Round {eval_round}

        Critical Findings: {count}
        1. [Critical] description
           Impact: why this breaks the plan
           Source: file:line or plan section

        Warning Findings: {count}
        1. [Warning] description
           Impact: risk if not addressed
           Source: file:line or plan section

        Info Findings: {count}
        1. [Info] description

        Substantive Findings: {Critical + Warning count}
        Verdict: PASS | FAIL"

  ② Codex Plan Evaluator (Bash tool, codex exec, timeout: 600000, foreground blocking)
     prompt: Plan Mode Protocol +
       "You are an independent plan evaluator. Round {eval_round}.
        Review this development plan. Read referenced source files to verify assumptions.
        Plan file: {plan_file_path}
        Source files: {file_list}

        Output MANDATORY format:
        Critical Findings: {count} — issues that break the plan
        Warning Findings: {count} — risks that should be addressed
        Info Findings: {count} — observations only
        Substantive Findings: {Critical + Warning count}
        Verdict: PASS (zero Critical+Warning) | FAIL"
     Use the codex exec command template (see "Review Architecture"); pass `-s read-only`.

  Degraded: when codex_available: false, run only the Claude Evaluator and mark the round
  as "single-evaluator".

  ──────────────────────────────────────────────────────────────
  STEP 2: Parse structured output and merge reports
  ──────────────────────────────────────────────────────────────
  **Barrier assertion (Sync Protocol rule 2)**: before entering this step, ALL of the
  following must hold:
    - claude_result has returned and is format-valid
    - codex_result has returned and is format-valid, OR codex_available == false
  If either fails → apply Sync Protocol rule 3 (retry Codex once in the same round; do NOT
  re-run Claude — the cached result is reused).
  Two consecutive rounds of Codex failure → force degraded mode
  (codex_available = false, degraded_from_round = eval_round).

  From the two reports extract:
  - Critical findings list (merged, de-duplicated)
  - Warning findings list (merged, de-duplicated)
  - Findings reported by both → high confidence
  - Findings reported by only one → the main agent arbitrates whether they apply

  Compute the merged substantive_count = Critical + Warning.

  ──────────────────────────────────────────────────────────────
  STEP 3: Record to eval_history + update per-evaluator counters (Sync Protocol rule 4)
  ──────────────────────────────────────────────────────────────
  Update state.json:
    claude_rounds_run += 1
    if codex's output was valid and merged this round: codex_rounds_run += 1
  Assert the invariants (violation → stop the loop and AskUserQuestion reporting a process
  failure):
    claude_rounds_run == eval_round
    codex_rounds_run == eval_round OR
      (codex_available == false AND codex_rounds_run == degraded_from_round - 1)

  {
    "round": eval_round,
    "phase": "plan",
    "timestamp": "ISO 8601",
    "claude_findings": N,
    "codex_findings": N,
    "merged_findings": N,
    "substantive_count": N,
    "status": "pass" | "fail"
  }

  ──────────────────────────────────────────────────────────────
  STEP 4: Verdict
  ──────────────────────────────────────────────────────────────

  If substantive_count == 0 (both evaluators PASS) → plan has converged, exit the loop.

  If substantive findings remain:
  - The main agent revises the plan based on the reports.
  - Write the revisions back to plan_file.
  - Return to STEP 1 (spawn fresh evaluators for the revised plan).

  More than 10 rounds without convergence → AskUserQuestion so the user can decide
  (accept current plan / keep polishing / abort).
  Every round, heartbeat-update state.json's eval_round and updated_at.
```

### 1.4 User gate

Display the final plan together with a summary of the evaluation convergence:
```
Plan evaluation convergence: {eval_rounds} rounds
  Round 1: substantive {N} (Critical {N}, Warning {N}) — FAIL
  Round 2: substantive {N} (Critical {N}, Warning {N}) — FAIL
  ...
  Round {N}: substantive 0 — PASS (converged)
```

Use AskUserQuestion to confirm the plan.

After confirmation:
- Update `state.json`: `phase: "docs"`
- Heartbeat `updated_at`

---

## Phase 2: DOCS

> **Lightweight mode (`sdd_mode: false`): skip this phase and go straight to IMPLEMENT.**
> The acceptance criteria and test cases from the plan stay in the plan file.

**Goal:** update the affected documentation. The hook only allows writes to doc files in
the allowlist.

### 2.1 Update documentation

Update the docs in `docs_allowlist` as required:

**PRD.md** (for requirement changes)

**ARCHITECTURE.md** (for architecture changes; also update the module progress overview — aggregation rule defined in §6.1.1)

**Affected MODULE-xxx.md** — update any affected section as needed:
- §1.1 Module Goals & Overview (when the task changes the module's purpose or goals)
- §2.1 Module Boundary (IN/OUT responsibilities when they change)
- §2.2 Dependencies (when upstream/downstream deps are added or changed)
- §2.3 Interface Definitions (when interface signatures change)
- §2.5 Data Models (when data structures change)
- §2.7 Core Logic (when business flows change)
- §2.8 Error Handling (when new error types are added)
- §2.12 State Management (when state transitions or cross-module state protocol change; if the MODULE doc was generated from a pre-2.1.0 template and lacks §2.12, add the section at this point)
- §2.9 Security Considerations (when security requirements change)
- §1.6 Non-functional Requirements (when SLA/NFR targets change — latency, availability, throughput; REQUIRED whenever a performance commitment to the user changes)
- §2.11 Operational Parameters (when operational tuning changes — timeouts, rate limits, pool sizes, retry policies; internal knobs that don't alter user-facing SLA)
- §1.5 Acceptance Criteria — **MUST** add new AC rows (ID format `MODULE-NNN-AC-nn`, REQ Source, Criterion, Verification). The §3.4 ledger is merge-preserved by /spec; new ACs are inserted there as `Active=Y, Status=untested` on the next /spec rerun.
- §3.3 Test Cases — **MUST** design comprehensive test cases (ID format `MODULE-NNN-T{nn}`, with AC Link column referencing the AC IDs added to §1.5).
- §3.8 Implementation Notes (when the implementation approach or architectural rationale changes; if the MODULE doc was generated from a pre-2.1.0 template and lacks §3.8, add the section at this point)
- §3.4 AC Verification ledger is the single source of truth for progress computation. **/dev DOCS does not hand-edit §3.4**: new ACs are declared in §1.5 (above) and propagate into §3.4 on the next `/spec` rerun (merge-preserve semantics). §3.4 row mutations are partitioned by phase: `/spec` owns row creation and `Active=Y↔N` flips; `/dev` SUMMARY owns only the `untested → passed` flip for this task's in-scope ACs. §3.1 Current Status is re-derived by SUMMARY via the formula in §6.1.1, no manual editing. §3.5 Feature Implementation Record stays hand-authored and is not regenerated by this workflow. Record this change in §3.7 Change History.

If a new module is needed, create it in full from the `/spec` three-part template
(Part 1 / Part 2 / Part 3) (update the allowlist first).

### 2.1.1 ADR check (2.5.0+, abort+restart pattern)

During DOCS phase, if the agent identifies that the task introduces a NEW architectural decision not covered by any existing Accepted ADR (e.g., choosing a new storage backend, auth flow, transport protocol, or any change that would warrant a Decision record in ARCHITECTURE.md §8), the agent MUST pause before writing docs and use AskUserQuestion:

```
This task contains a new architectural decision: {brief description}.

Options:
 (A) ADR-worthy — I'll stop here. You then run, in order:
       /dev abort
       /spec adr-new "{suggested title}"
       /dev {original task description}
     (I will print the 3 commands for copy-paste and exit. Your next /dev
      invocation will automatically detect the stale state.json at Phase 0 INIT
      and prompt you for resume/abort/cancel — so even if you skip the explicit
      /dev abort step, the workflow recovers cleanly.)
 (B) Skip ADR — this is an implementation-level detail, not a cross-cutting architecture decision.
 (C) Already covered — Accepted ADR {filename} governs this; I'll note it in the DOCS reasoning.
```

- **Option A**: the agent prints the 3 exact commands and STOPS taking action this session. The agent does NOT self-invoke `/dev abort` — that operation requires deleting `.dev-state/state.json`, but DOCS phase's `check-phase.sh` locks `rm` / `Write` against state.json to an allowed-but-narrow path, and self-invocation of a slash command from inside its own active run is not a supported pattern. **Recovery paths (both sanctioned)**:
  - **Recommended path**: user copies the 3 commands in order — `/dev abort` → `/spec adr-new "..."` → `/dev {task}`. First command cleanly deletes state.json.
  - **Skip-abort path**: user skips the explicit `/dev abort` step and runs only `/spec adr-new "..."` + `/dev {task}`. Phase 0 INIT's `ACTIVE_WORKFLOW: YES` branch (§0.1) detects the stale state.json from the paused task and issues an AskUserQuestion `resume / abort and restart / cancel`. User chooses "abort and restart" → fresh state.json. Built-in safety net, not a second-class recovery path.

  Both paths terminate in a fresh `/dev` run that sees the new ADR via Phase 1 PLAN's CONTEXT-MAP load (CONTEXT-MAP is re-derived from mtime including `docs/adr/*.md` per the §1.1 staleness check). No race conditions, no self-invocation.
- **Option B**: continue DOCS normally; no state change.
- **Option C**: no write action. The referenced ADR was already loaded by Phase 1 PLAN (via CONTEXT-MAP routing → `adr_decisions` cache → `## ADR compliance` block in the plan file written during PLAN phase). The agent acknowledges the ADR's coverage in DOCS reasoning prose (printable to stdout, no plan-file edit — DOCS phase's hook forbids writes to `~/.claude/plans/*.md` since those are PLAN-phase artifacts) and continues DOCS normally. If during PLAN the ADR wasn't in scope, the user should take Option A instead and restart with a fresh PLAN that picks up the ADR.

**docs/adr/ allowlist convention (2.5.0+)**: when the plan's `## ADR compliance` block is non-empty (either fresh or fallback path), the Plan phase (§1.2) automatically appends `docs/adr/*.md` to `docs_allowlist` as a read-only-needed set — this gives the DOCS-phase hook a path to WRITE to individual ADR files if the task requires a minor ADR correction (e.g., updating a `Modules affected:` bullet after a module rename). The agent SHOULD use this sparingly; substantial ADR changes (Decision text, Status flip) still go through Option A's abort+restart flow so /spec Phase 1.0 can rebuild `_INDEX.md` and re-run conflict detection.

**Why abort+restart, not in-place pause?** Adding a `docs-paused-for-adr` phase enum to `state.json` would need a matching branch in `check-phase.sh` (the PreToolUse hook), expanding a hook surface that's currently narrow and well-tested. The abort+restart pattern preserves the existing `/dev` phase state machine (plan → docs → implement → audit → test → summary, with adversarial running as a subphase of test per §5.2) and keeps `check-phase.sh` untouched. The existing INIT `ACTIVE_WORKFLOW: YES` recovery path supplies the user-facing UX — we don't invent a new one.

### 2.2 User gate

Display a summary of the doc changes.
Use AskUserQuestion to confirm the doc changes.

After confirmation:
- Update `state.json`: `phase: "implement"`
- Heartbeat `updated_at`

---

## Phase 3: IMPLEMENT

**Goal:** write code according to the plan. The hook opens access to all files inside the
repo.

- Follow the interface definitions (§2.3) and implementation notes (§3.8) in the MODULE docs.
- Code incrementally per the implementation steps in the PLAN.
- Implement the test cases defined in MODULE §3.3 (linked to §1.5 ACs via the AC Link column).

### 3.1 User gate

Use AskUserQuestion to confirm that coding is complete.

After confirmation:
- **If `docs/REQUIREMENTS_REGISTRY.md` exists:**
  - Add `REQUIREMENTS_REGISTRY.md` to `docs_allowlist` (if not already present).
  - Update the affected REQ-IDs: Status → Implemented, Updated → current date.
  - Fold the registry status change into the implement commit below.
- **Mandatory commit**: stage ONLY the files modified by this task (confirm the list via
  `git diff --name-only`), then commit.
  ```bash
  git add src/foo.ts src/bar.ts tests/foo.test.ts docs/REQUIREMENTS_REGISTRY.md  # list every file explicitly
  git commit -m "dev({task_id}): implement {brief description}

  REQ: {REQ-001, REQ-005, ...}
  AC: {MODULE-001-AC-01, MODULE-001-AC-02, MODULE-003-AC-05, ...}"
  ```
  (This ensures Phase 4's `git diff start_commit..HEAD` sees all changes, so the audit
  target is deterministic and reproducible. Do NOT use `git add -A` — that risks
  committing unfinished work from outside this task.)
- Update `state.json`: `phase: "audit"`
- Heartbeat `updated_at`

---

## Phase 4: AUDIT (independent evaluator architecture)

**Goal:** use independent evaluators to verify code quality until doc consistency + diff
review both converge.

**Convergence metric: substantive_count (Critical + Warning) == 0.**

### 4.1 Audit evaluation loop

```
eval_round = state.eval_round  # supports resume

repeat:
  eval_round += 1

  ──────────────────────────────────────────────────────────────
  STEP 1: Spawn FRESH audit evaluators in parallel
  (Per Dual-Evaluator Sync Protocol rule 1: all 4 evaluators MUST be fired side-by-side
   in the SAME assistant response, not split across sequential responses. Even under
   degraded / lightweight mode, the actually-invoked subset still has to be fired in one
   response.)
  ──────────────────────────────────────────────────────────────

  Launch 4 evaluators at once (2 pairs: doc consistency + diff review):

  ── Doc consistency evaluation (skipped in lightweight mode) ──

  ① Claude Doc Evaluator (Agent tool, subagent_type: claude-auditor)
     prompt:
       "You are an independent doc-vs-code evaluator. Round {eval_round}.
        You have ZERO knowledge of how this code was implemented.

        Compare MODULE documentation against source code implementation,
        chapter by chapter (chapters 1-10).

        MODULE docs (in scope, modifiable): {docs_list}
        Source files: {file_list}
        Affected downstream MODULE docs (read-only contract verification): {downstream_docs_list}

        For affected downstream MODULE docs (only when state.json has affected_downstream_modules
        not in scope_expansion — Option 2 read-only mode), perform DOCUMENT-LEVEL only:
        - Verify §2.2 Required Contract entries referencing modified_contracts still exist
          in §6.1 Contract Registry as Active=Y
        - Verify §2.2 Required Contract Provider Module matches §6.1
        - Verify §1.5 has at least one AC referencing each Required Contract (coverage)
        - Mismatches → Critical (contract reference broken at doc level)
        Do NOT read consumer source code or attempt cross-module static analysis.
        Behavior compatibility delegated to Test Regression Check.

        Output format (MANDATORY):
        Doc Consistency Evaluation: Round {eval_round}

        Critical Findings: {count}
        1. [Critical] description — doc says X, code does Y
           Source: {file:line} vs {doc:section}

        Warning Findings: {count}
        1. [Warning] description
           Source: {file:line} vs {doc:section}

        Info Findings: {count}
        1. [Info] description

        Substantive Findings: {Critical + Warning count}
        Verdict: PASS | FAIL"

  ② Codex Doc Evaluator (Bash tool, codex exec, timeout: 600000, foreground blocking)
     prompt: Plan Mode Protocol +
       "Independent doc-vs-code evaluator. Round {eval_round}.
        Compare MODULE docs against source code, chapter by chapter.
        Docs: {docs_list}. Source files: {file_list}.
        Output: Critical/Warning/Info findings with doc:section and file:line.
        Substantive Findings count. Verdict: PASS | FAIL."
     Use the codex exec command template; `-s read-only`.

  ── Diff Review evaluation ──

  ③ Claude Diff Evaluator (Agent tool, subagent_type: claude-auditor)
     prompt:
       "You are an independent diff reviewer. Round {eval_round}.
        You have ZERO knowledge of implementation decisions.

        First pass: scan every line of the diff for surface issues.
        Second pass: analyze logic, security, edge cases.
        Third pass: read surrounding source for context.

        Diff: git diff {start_commit}..HEAD
        Source files: {file_list}

        Contract Drift detection (only if state.json has modified_contracts):
        Two-step algorithm to avoid sibling contract false-positives:
        Step 1: candidate_contracts = union of contracts whose §2.3 Source Files
                contains any modified file (any-match, multi-to-multi tolerant)
        Step 2: confirmed_modified = subset of candidate where diff hunks actually
                touch signature surface (added/removed methods, changed param/return
                types, changed field types, changed enum members). Behavior-only
                changes (function body, formatting, private helpers, sibling functions
                in same file) do NOT promote.
        Step 3: confirmed has contracts NOT in declared modified_contracts → Critical
                (silent contract change, triggers rollback path c)
                declared has contracts NOT in confirmed → Info (over-declaration)
                candidate but not confirmed (sibling unchanged) → not reported
        Step 4: Report under 'Contract Drift' output section with file:line

        Output format (MANDATORY):
        Diff Review: Round {eval_round}

        Critical Findings: {count}
        1. [Critical] description
           Impact: what breaks
           Source: {file:line}

        Warning Findings: {count}
        1. [Warning] description
           Impact: risk
           Source: {file:line}

        Info Findings: {count}
        1. [Info] description

        Substantive Findings: {Critical + Warning count}
        Verdict: PASS | FAIL"

  ④ Codex Diff Evaluator (Bash tool, codex exec, timeout: 600000, foreground blocking)
     prompt: Plan Mode Protocol +
       "Independent diff reviewer. Round {eval_round}.
        Run: git diff {start_commit}..HEAD
        First: scan every line for surface issues.
        Then: read source files {file_list} for deeper analysis.
        Apply Code Review Checklist: spec/plan match, error handling, boundary conditions,
        complexity, test coverage (normal + exception), security (injection/XSS/escalation),
        performance (N+1, unbounded loops, leaks), spec-required logging hooks.
        Contract Drift detection (if state.json has modified_contracts):
        Step 1: candidate_contracts = contracts whose §2.3 Source Files contains any
                modified file (multi-to-multi tolerant)
        Step 2: confirmed_modified = candidate where diff hunks touch signature surface
                (added/removed methods, changed param/return/field types)
        Step 3: confirmed not in declared → Critical (silent change); declared not in
                confirmed → Info; sibling unchanged → not reported
        Step 4: report under 'Contract Drift' section
        Output: Critical/Warning/Info findings with file:line + Contract Drift section.
        Substantive Findings count. Verdict: PASS | FAIL."
     Use the codex exec command template; `-s read-only`.

  Degraded: when codex_available: false, run only ① and ③ and mark as "single-evaluator".
  Lightweight mode (sdd_mode: false): skip ① and ②; run only ③ and ④ (Diff Review).

  ──────────────────────────────────────────────────────────────
  STEP 2: Merge evaluation reports
  ──────────────────────────────────────────────────────────────
  **Barrier assertion (Sync Protocol rule 2)**: before entering this step, ALL of the
  following must hold:
    - Claude results for ① and ③ have returned and are format-valid
    - Codex results for ② and ④ have returned and are format-valid, OR codex_available == false
  If either fails → apply Sync Protocol rule 3 (retry Codex once in the same round).
  Two consecutive rounds of Codex failure → force degraded mode
  (codex_available = false, degraded_from_round = eval_round).

  Merge 4 reports (or 2 in degraded/lightweight mode):
  - Doc consistency: merge and de-dupe findings from Claude ① + Codex ②.
  - Diff review: merge and de-dupe findings from Claude ③ + Codex ④.
  - Cross-dimension: take the union of findings across both dimensions.
  - Findings reported by both evaluators → high confidence.
  - Findings reported by only one → the main agent arbitrates whether they apply.

  Compute the merged substantive_count = Critical + Warning.

  ──────────────────────────────────────────────────────────────
  STEP 3: Record to eval_history + update per-evaluator counters (Sync Protocol rule 4)
  ──────────────────────────────────────────────────────────────
  Update state.json:
    claude_rounds_run += 1
    if codex's output was valid and merged this round: codex_rounds_run += 1
  Assert the invariants (violation → stop the loop and AskUserQuestion reporting a process
  failure):
    claude_rounds_run == eval_round
    codex_rounds_run == eval_round OR
      (codex_available == false AND codex_rounds_run == degraded_from_round - 1)

  {
    "round": eval_round,
    "phase": "audit",
    "timestamp": "ISO 8601",
    "claude_findings": N,
    "codex_findings": N,
    "merged_findings": N,
    "substantive_count": N,
    "doc_findings": N,
    "diff_findings": N,
    "status": "pass" | "fail"
  }

  ──────────────────────────────────────────────────────────────
  STEP 4: Verdict
  ──────────────────────────────────────────────────────────────

  If substantive_count == 0 → audit has converged:
  - Flip completed acceptance criteria from `- [ ]` to `- [x]`.
  - Exit the loop.

  If substantive findings remain:
  - The main agent fixes code / docs based on the reports.
  - **Commit fixes**: stage only the files touched in this round (confirm via
    `git diff --name-only`) and commit:
    ```bash
    git add <files modified this round>
    git commit -m "dev({task_id}): audit fix round {eval_round}

    REQ: {REQ-IDs}
    AC: {AC-IDs}"
    ```
  - Evaluate the scope of the fix:
    a) Pure code fix → stay in AUDIT, return to STEP 1.
    b) Fix changes the interface / acceptance criteria / scope / data model
       → roll back to DOCS (rollback rule).
       → If the change affects §1.5 AC (add/remove/modify) or §2.1 module boundaries:
         after DOCS, you MUST update the plan file's Traceability YAML block
         (align req_ac_map / in_scope_ac_ids with the current §1.5),
         sync state.json, then re-run the Plan Evaluator (§1.3 evaluation loop);
         only continue into IMPLEMENT after it has converged.
    c) The Diff Evaluator reports a Contract Drift Critical (v3.2 silent contract change)
       → roll back to the **PLAN** phase (not DOCS).
       → Because the modified_contracts set was wrong, the entire
         affected_downstream_modules / regression_check_ac_ids must be recomputed.
       → PLAN re-runs the Impact Analysis and re-triggers the three-option AskUserQuestion.
       → scope_expansion_depth is reset to 0.
  - Return to STEP 1 (spawn fresh evaluators).

  More than 10 rounds without convergence → AskUserQuestion so the user can decide.
  Every round, heartbeat-update state.json's eval_round and updated_at.
```

After the audit converges:
- Update `state.json`: `phase: "test"`
- Heartbeat `updated_at`

---

## Phase 5: TEST (independent evaluator architecture)

**Goal:** use independent evaluators to verify code quality until all tests pass and the
adversarial evaluation passes.

**Core idea (from autoresearch):** evaluators are fully separated from implementers. Every
round spawns fresh independent agents with zero implementation context, seeing only the
spec + code + test results. Test pass rate is the single objective metric.

### 5.0 Test phase entry pre-check

Before entering the TEST phase, verify that `state.json`'s `req_ac_map` /
`in_scope_ac_ids` / `waived_scope` match the plan file's Traceability YAML block. On
mismatch → re-sync from the plan YAML into `state.json` and issue a warning.

### 5.1 Test evaluation loop

```
eval_round = state.eval_round  # restored from state (supports resume)

repeat:
  eval_round += 1

  ──────────────────────────────────────────────────────────────
  STEP 1: Spawn two FRESH evaluators in parallel
          (each round must use brand-new agents)
  (Per Dual-Evaluator Sync Protocol rule 1: the Claude Agent call and the Codex Bash call
   MUST be fired side-by-side in the SAME assistant response, not sequentially.)
  ──────────────────────────────────────────────────────────────

  ① Claude Test Evaluator (Agent tool, subagent_type: claude-auditor)
     prompt:
       "You are an independent test evaluator. Evaluation round {eval_round}.
        You have ZERO knowledge of how this code was implemented or what was tried before.

        Your job: run the test command, analyze ALL results, diagnose root causes.
        Do NOT suggest fixes — only diagnose.

        Plan file: {plan_file_path}  (read it for acceptance criteria)
        Test command: {test_cmd}
        Source files: {file_list}
        MODULE docs: {module_docs_list}

        After analyzing test results, produce an AC Verification block.
        SCOPE: only check the EXACT AC-IDs from state.json in_scope_ac_ids
        (e.g. MODULE-001-AC-01, MODULE-003-AC-05). Do NOT expand to all ACs under those REQs.
        Read MODULE docs acceptance criteria (section 1.5) and test case AC Links (section 3.3).
        For each in-scope AC, determine PASS/FAIL/UNTESTED.

        Also check non-functional requirements from MODULE docs (section 1.6):
        - If MODULE specifies SLA targets, confirm test evidence meets them
        - Report unverified NFRs as Coverage Gaps

        Output format:
        Test Results: {pass}/{total} passed ({rate}%)
        Failures:
        1. [test_name] — error_summary
           Root cause: diagnosis
           Severity: Critical|Warning
           Source: file:line
        Coverage Gaps:
        - untested path description
        AC Verification (scoped to in_scope_ac_ids from state.json):
        - MODULE-001-AC-01: PASS (verified by MODULE-001-T01, MODULE-001-T04)
        - MODULE-001-AC-03: FAIL (MODULE-001-T02 failed)
        - MODULE-003-AC-05: UNTESTED
        AC Tested: {tested}/{total} ({ac_tested_rate}%)
        AC Passed: {passed}/{tested} ({ac_pass_rate}%)

        Regression Check (skip entire block if regression_check_ac_ids is empty;
        otherwise render by regression_gate_status — fix #25):
        For each regression_check_ac_id, find linked tests in downstream §3.3 (via AC Link)
        and determine status:
        - PASS: §3.3 has linked test, all linked tests passed
        - REGRESSION: §3.3 has linked test, at least one failed (was passed in §3.4)
        - NO_TEST_DEFINED: §3.3 has no test with AC Link to this AC
        - NO_TEST_IMPLEMENTED: §3.3 declares test ID but test_cmd output has no matching test

        Output by regression_gate_status (5 states, do NOT emit `null%` or `0/0 (null%)`):

        [if regression_gate_status == \"applicable\" (tested > 0):]
        Regression Check:
        - MODULE-003-AC-01: PASS (verified by MODULE-003-T01)
        - MODULE-003-AC-02: REGRESSION (was passed in §3.4, now failing — diagnosis)
        - MODULE-005-AC-04: NO_TEST_DEFINED
        - MODULE-005-AC-07: NO_TEST_IMPLEMENTED
        Regression Tested: {tested}/{total} ({regression_tested_rate*100}%)
        Regression Passed: {passed}/{tested} ({regression_pass_rate*100}%)
        NO_TEST: {no_test_defined_count} undefined + {no_test_implemented_count} unimplemented

        [if regression_gate_status == \"no_tested\" (regression_check_ac_ids non-empty, tested == 0):]
        Regression Check:
        - MODULE-005-AC-04: NO_TEST_DEFINED
        - MODULE-005-AC-07: NO_TEST_IMPLEMENTED
        ⚠️  All {N} regression-scope AC are NO_TEST (no rates applicable).
        NO_TEST: {no_test_defined_count} undefined + {no_test_implemented_count} unimplemented
        Cross-module protection ineffective: AC scope declared but tests not implemented.

        [if regression_gate_status == \"no_historical_ac\"
         (affected_downstream_modules non-empty, regression_check_ac_ids empty):]
        Regression Check:
        ⚠️  {N} downstream module(s) affected by modified_contracts: {module list}
            but none of their consumer-side AC have been verified historically
            (§3.4 all untested). Cross-module protection NOT available — relies on
            test_cmd full pass_rate and manual review.

        [if regression_gate_status in {\"no_downstream\", \"degraded\"}:
         omit Regression Check block entirely]

        Verdict: PASS | FAIL"

  ② Codex Test Evaluator (Bash tool, codex exec, timeout: 600000, foreground blocking)
     prompt: Plan Mode Protocol +
       "You are an independent test evaluator. Round {eval_round}.
        Run: {test_cmd}
        Analyze ALL failures — not just the first one.
        For each failure: test name, error message, root cause diagnosis with file:line.
        Read source files to trace root causes: {file_list}
        Also read MODULE docs: {module_docs_list}.
        After test analysis, produce AC Verification for EXACTLY the AC-IDs from
        state.json in_scope_ac_ids (e.g. MODULE-001-AC-01). Do NOT expand beyond that list.
        Format: MODULE-NNN-AC-xx: PASS|FAIL|UNTESTED (test IDs).
        AC Tested: tested/total. AC Passed: passed/tested.
        Check section 1.6 NFR/SLA targets. Report unverified NFRs as Coverage Gaps.

        Regression Check (skip if regression_check_ac_ids empty; render by gate_status — fix #25):
        Read {downstream_docs_list}. For each regression_check_ac_id, find linked tests
        in downstream §3.3 (via AC Link). Status taxonomy:
        - PASS: linked test ran and passed
        - REGRESSION: linked test ran and failed (was passed in §3.4)
        - NO_TEST_DEFINED: §3.3 has no test with AC Link
        - NO_TEST_IMPLEMENTED: §3.3 declares test but test_cmd output absent

        Render by regression_gate_status (5 states, do NOT emit `null%` or `0/0 (null%)`):
        - \"applicable\" (tested > 0): per-AC status, Regression Tested/Passed rates as
          percentages, NO_TEST counts
        - \"no_tested\" (regression_check_ac_ids non-empty, tested == 0):
          per-AC status (all NO_TEST_*), \"⚠ All N regression-scope AC are NO_TEST\",
          NO_TEST counts, coverage warning
        - \"no_historical_ac\" (affected_downstream_modules non-empty, regression_check_ac_ids empty):
          \"⚠ N downstream module(s) affected but none have historically verified AC —
          cross-module protection NOT available\" + list affected_downstream_modules
        - \"no_downstream\" / \"degraded\": do NOT emit Regression Check block at all

        Do NOT suggest fixes. Only diagnose.
        Output: pass/fail counts, per-failure analysis, coverage gaps, AC Verification, Regression Check."
     Use the codex exec command template (see "Review Architecture"); `-s read-only`.

  Degraded: when codex_available: false, run only the Claude Evaluator and mark as
  "single-evaluator".

  ──────────────────────────────────────────────────────────────
  STEP 2: Merge evaluation reports
  ──────────────────────────────────────────────────────────────
  **Barrier assertion (Sync Protocol rule 2)**: before entering this step, ALL of the
  following must hold:
    - claude_result has returned and is format-valid
    - codex_result has returned and is format-valid, OR codex_available == false
  If either fails → apply Sync Protocol rule 3 (retry Codex once in the same round).
  Two consecutive rounds of Codex failure → force degraded mode
  (codex_available = false, degraded_from_round = eval_round).

  - Extract pass/fail counts from both reports (should match; on mismatch, flag and take
    the stricter value).
  - Merge failure analyses: root causes diagnosed by both → high confidence.
  - Findings reported by only one → main agent arbitrates.
  - Merge coverage-gap analyses.

  ──────────────────────────────────────────────────────────────
  STEP 3: Record to eval_history + update per-evaluator counters (Sync Protocol rule 4)
  ──────────────────────────────────────────────────────────────
  Update state.json:
    claude_rounds_run += 1
    if codex's output was valid and merged this round: codex_rounds_run += 1
  Assert the invariants (violation → stop the loop and AskUserQuestion reporting a process
  failure):
    claude_rounds_run == eval_round
    codex_rounds_run == eval_round OR
      (codex_available == false AND codex_rounds_run == degraded_from_round - 1)

  Append the following JSON to state.json's eval_history array:
  {
    "round": eval_round,
    "phase": "test",
    "timestamp": "ISO 8601",
    "pass_count": N,
    "fail_count": N,
    "total": N,
    "pass_rate": 0.0-1.0,
    "claude_findings": N,
    "codex_findings": N,
    "merged_findings": N,
    "ac_results": {
      "MODULE-001-AC-01": "pass",
      "MODULE-001-AC-03": "fail",
      "MODULE-003-AC-05": "untested"
    },
    "ac_tested_rate": 0.67,
    "ac_pass_rate": 1.0,
    "regression_check_results": {
      "MODULE-003-AC-01": "pass",
      "MODULE-003-AC-02": "regression",
      "MODULE-005-AC-04": "no_test_defined",
      "MODULE-005-AC-07": "no_test_implemented"
    },
    "regression_tested_rate": 0.5,
    "regression_pass_rate": 0.5,
    "regression_gate_status": "applicable",
    "no_test_defined_count": 1,
    "no_test_implemented_count": 1,
    "status": "pass" | "fail"
  }
  Boundary example (everything NO_TEST_*):
  "regression_pass_rate": null, "regression_gate_status": "no_tested",
  "regression_tested_rate": 0.0, "no_test_defined_count": 2, "no_test_implemented_count": 1
  Type contract: rate fields stay numeric/null (never the string "N/A"); state is carried
  by the regression_gate_status enum.
  Semantics: ac_tested_rate = tested/(tested+untested), ac_pass_rate = passed/tested.
  DoD verdict: ac_tested_rate == 1.0 AND ac_pass_rate == 1.0.
  If in_scope_ac_ids is empty (pure waived-scope task) → skip the ac_results block.
  Update state.json: eval_round, test_attempts, updated_at.

  ──────────────────────────────────────────────────────────────
  STEP 4: Verdict
  ──────────────────────────────────────────────────────────────

  **Gate conditions (fix #22: mechanical decision, do not trust evaluator-authored Verdicts)**

  Advance to 5.2 adversarial evaluation if and only if **all** of the following hold:
  1. `pass_rate == 1.0` (all project tests pass).
  2. If `in_scope_ac_ids` is non-empty:
     - `ac_tested_rate == 1.0` (no UNTESTED in-scope AC).
     - `ac_pass_rate == 1.0` (no FAIL among tested in-scope AC).
  3. If `regression_check_ac_ids` is non-empty (`regression_gate_status == "applicable"`):
     - `regression_pass_rate == 1.0` (no REGRESSION among tested downstream AC).
  4. Other `regression_gate_status` values ("no_tested" / "no_historical_ac" /
     "no_downstream" / "degraded") do not block advancement.

  The main agent reads the latest entry in state.json's eval_history and decides directly
  from those fields (not from the free-form Verdict text).
  If any condition fails → go to the "failures remain" branch below.
  The Verdict field from the Test Evaluator is read back only as a cross-check; if the
  main agent's decision conflicts with the Verdict → flag as evaluator data error
  (the evaluator may need to be re-run).

  If failures remain:
  - The main agent reads the merged evaluation report (NOT the raw test output).
  - Fix the code based on the evaluators' root-cause diagnoses.
  - **Commit fixes**: stage only the files touched this round (confirm via
    `git diff --name-only`) and commit:
    ```bash
    git add <files modified this round>
    git commit -m "dev({task_id}): test fix round {eval_round}

    REQ: {REQ-IDs}
    AC: {AC-IDs}"
    ```
  - Evaluate the scope of the fix:
    a) Pure implementation-detail fix → stay in TEST, increment test_attempts.
    b) Fix changes the interface / acceptance criteria / scope / data model
       → roll back to DOCS: set state.json phase: "docs".
       → Re-run DOCS → IMPLEMENT → AUDIT → TEST.
       → If the change affects §1.5 AC (add/remove/modify) or §2.1 module boundaries:
         after DOCS you must update the plan file's Traceability YAML block
         (align req_ac_map / in_scope_ac_ids with the current §1.5),
         sync state.json, then re-run the Plan Evaluator (§1.3 evaluation loop);
         only continue into IMPLEMENT after it converges.
    c) Fix changes a contract (modified_contracts set grows or shrinks)
       → roll back to the **PLAN** phase (not DOCS).
       → Because the modified_contracts set was wrong, the entire
         affected_downstream_modules / regression_check_ac_ids must be recomputed.
       → PLAN re-runs the Impact Analysis and re-triggers the three-option AskUserQuestion.
       → scope_expansion_depth is reset to 0.
    d) Test Evaluator reports REGRESSION (regression_pass_rate < 1.0 in applicable mode)
       → first attempt to fix in IMPLEMENT (keep contract compatibility).
       → If the fix must change a contract → take path (c) and roll back to PLAN.
       → If the user does not want to fix forward → AskUserQuestion: accept the regression
         and abort the task (REGRESSION is NOT allowed into SUMMARY).
  - Return to STEP 1 (spawn fresh evaluators with zero context from the previous round).

  test_attempts > max_test_attempts (10) → AskUserQuestion (continue fixing / skip / abort).
```

### 5.2 Adversarial evaluation loop

Also uses the independent evaluator architecture: every round spawns fresh agents with
zero implementation context.

```
repeat:
  eval_round += 1

  ──────────────────────────────────────────────────────────────
  STEP 1: Spawn two FRESH adversarial evaluators in parallel
  (Per Dual-Evaluator Sync Protocol rule 1: the Claude Agent call and the Codex Bash call
   MUST be fired side-by-side in the SAME assistant response, not sequentially.)
  ──────────────────────────────────────────────────────────────

  ① Claude Adversarial Evaluator (Agent tool, subagent_type: claude-auditor)
     prompt:
       "You are an independent security evaluator. Fresh context — round {eval_round}.
        You have ZERO knowledge of implementation decisions or prior review rounds.

        Review the diff from an attacker and chaos engineer perspective.
        Find: security holes, race conditions, resource leaks, data corruption paths,
        auth bypasses, trust boundary violations.
        No compliments — only problems.

        Diff command: git diff {start_commit}..HEAD
        Source files: {file_list}

        Output format:
        Security Findings: N total (Critical: X, Warning: Y, Info: Z)
        1. [severity] finding_description
           Attack vector: how_to_exploit
           Source: file:line
        Verdict: PASS | FAIL"

  ② Codex Adversarial Evaluator (Bash tool, codex exec, timeout: 600000, foreground blocking)
     prompt: Plan Mode Protocol +
       "You are an independent security evaluator. Round {eval_round}. Fresh context.
        Run: git diff {start_commit}..HEAD
        Read source files: {file_list}
        Find security vulnerabilities, race conditions, resource leaks, data corruption,
        auth bypasses. Trace call chains to verify trust boundaries.
        Apply STRIDE model: Spoofing, Tampering, Repudiation, Info Disclosure, DoS, Elevation.
        If ARCHITECTURE.md has Threat Model (§11), verify mitigations are implemented.
        No compliments. Only report problems with severity, attack vector, file:line."
     Use the codex exec command template (see "Review Architecture"); `-s read-only`.

  Degraded: when codex_available: false, run only the Claude Evaluator and mark as
  "single-evaluator".

  ──────────────────────────────────────────────────────────────
  STEP 2: Merge adversarial reports
  ──────────────────────────────────────────────────────────────
  **Barrier assertion (Sync Protocol rule 2)**: before entering this step, ALL of the
  following must hold:
    - claude_result has returned and is format-valid
    - codex_result has returned and is format-valid, OR codex_available == false
  If either fails → apply Sync Protocol rule 3 (retry Codex once in the same round).
  Two consecutive rounds of Codex failure → force degraded mode
  (codex_available = false, degraded_from_round = eval_round).

  - Findings reported by both evaluators → high confidence.
  - Findings reported by only one → the main agent arbitrates.
  - Compute the merged substantive_count = Critical + Warning.

  ──────────────────────────────────────────────────────────────
  STEP 3: Record to eval_history + update per-evaluator counters (Sync Protocol rule 4)
  ──────────────────────────────────────────────────────────────
  Update state.json:
    claude_rounds_run += 1
    if codex's output was valid and merged this round: codex_rounds_run += 1
  Assert the invariants (violation → stop the loop and AskUserQuestion reporting a process
  failure):
    claude_rounds_run == eval_round
    codex_rounds_run == eval_round OR
      (codex_available == false AND codex_rounds_run == degraded_from_round - 1)

  {
    "round": eval_round,
    "phase": "adversarial",
    "timestamp": "ISO 8601",
    "claude_findings": N,
    "codex_findings": N,
    "merged_findings": N,
    "substantive_count": N,
    "status": "pass" | "fail"
  }

  ──────────────────────────────────────────────────────────────
  STEP 4: Verdict
  ──────────────────────────────────────────────────────────────

  substantive_count == 0 (zero Critical + zero Warning) → converged, exit the loop.

  substantive_count > 0 → fix the code:
    **Commit fixes**: stage only the files touched this round (confirm via
    `git diff --name-only`) and commit:
    ```bash
    git add <files modified this round>
    git commit -m "dev({task_id}): adversarial fix round {eval_round}

    REQ: {REQ-IDs}
    AC: {AC-IDs}"
    ```
    Does the fix change interface / acceptance criteria / scope / data model?
      Yes → roll back to DOCS (rollback rule).
        → If the change affects §1.5 AC or §2.1 module boundaries:
          after DOCS, update the plan file's Traceability YAML block
          (align req_ac_map / in_scope_ac_ids with the current §1.5),
          sync state.json, then re-run the Plan Evaluator (§1.3 evaluation loop);
          only continue into IMPLEMENT after it converges.
      No → re-run 5.1 test evaluation loop to confirm no regression, then return to STEP 1.

  More than 10 rounds without convergence → AskUserQuestion so the user can decide.
  Every round, heartbeat-update state.json's updated_at.
```

### 5.3 Definition of Done

Before entering the SUMMARY phase, every one of these conditions must hold:

| Dimension | Criterion | Verified By |
|-----------|----------|-------------|
| **Function** | ac_pass_rate == 100% (all tested AC passed) | Test Evaluator AC Verification (5.1) |
| **Testing** | pass_rate == 100% (all tests passed) | Test Evaluator (5.1) |
| **Testing** | ac_tested_rate == 100% (no UNTESTED AC) | Test Evaluator AC Verification (5.1) |
| **Security** | Adversarial Evaluator Verdict == PASS | Adversarial Evaluator (5.2) |
| **Code Quality** | Diff Review Verdict == PASS | Diff Evaluator (4.1) |
| **Doc Consistency** | Doc Evaluator Verdict == PASS (sdd_mode only) | Doc Evaluator (4.1) |
| **Regression** | regression_gate_status applicable + regression_pass_rate==1.0; or no_tested/no_historical_ac/no_downstream/degraded | Test Evaluator Regression Check (5.1) |
| **Findings Closure** | deferred_findings == [] OR all entries have user_accepted_at timestamp (fix #29) | Main agent enforced |

**Hard gates** (enforced by the evaluators; only over the in_scope_ac_ids in state.json):
- pass_rate == 100% (all tests pass).
- in_scope AC ac_tested_rate == 100% (no UNTESTED).
- in_scope AC ac_pass_rate == 100% (no FAIL).
- Adversarial substantive_count == 0.
- **Regression gate** (v3.2 cross-module, decided by regression_gate_status enum — 5 states):
  - "applicable" → require regression_pass_rate == 1.0 (REGRESSION is NOT allowed).
  - "no_tested" → treated as PASS (regression_check_ac_ids non-empty but all NO_TEST_*;
    emit a **strong Warning**).
  - "no_historical_ac" → treated as PASS (affected_downstream non-empty but no historically
    passed AC; emit a **strong Warning**).
  - "no_downstream" → treated as PASS (no downstream impact; Info level).
  - "degraded" → treated as PASS (contract_registry_available == false; Info level).
  - REGRESSION is never allowed (in applicable mode, regression_pass_rate < 1.0 → Critical
    hard fail).

**Soft gates / Regression warnings:**
- regression_gate_status == "no_tested" → **strong Warning** in SUMMARY:
  "Cross-module protection ineffective: AC declared but tests not implemented".
- regression_gate_status == "no_historical_ac" → **strong Warning** in SUMMARY:
  "N downstream module(s) affected but none have historically verified AC —
   cross-module protection NOT available; relies on test_cmd and manual review".
- regression_gate_status == "applicable" AND regression_tested_rate < 1.0 → Warning:
  explicitly list NO_TEST_DEFINED / NO_TEST_IMPLEMENTED ACs; non-blocking.
- regression_gate_status == "no_downstream" → Info (natural state, no warning needed).
- regression_gate_status == "degraded" → Info (normal state on legacy v3.1.0 projects).

**Soft gates** (can be user-accepted past the round limit): Doc Consistency, Diff
Info-only findings.

Degraded mode (codex_available: false): only the Claude Evaluator needs to PASS.
Lightweight mode (sdd_mode: false): skip Doc Consistency.

**DoD AC-scope rule:**
DoD checks the **subset of ACs declared in-scope during the Plan phase** (state.json's
in_scope_ac_ids), NOT every AC under the REQ.
Example: REQ-001 has AC-01..AC-05; this task only declared verification for AC-01 and
AC-02 → DoD checks only those two.

**Waived-scope handling (when state.json's waived_scope is non-empty):**
- **Traceability for registered REQs keeps operating normally** — ACs in `in_scope_ac_ids`
  are checked as usual.
- The Plan Evaluator does not raise Critical findings against waived scope.
- The Test Evaluator's AC Verification only checks `in_scope_ac_ids` (waived scope
  produces no AC entries).
- DoD's AC gate only looks at `in_scope_ac_ids` (if empty → skip the AC dimension).
- SUMMARY output notes "Waived scope: {descriptions}".
- If `in_scope_ac_ids` is non-empty → §3.4 AC ledger and Registry are updated as usual
  (committed by the SUMMARY commit in §6).
- If `in_scope_ac_ids` is empty (pure waived-scope task) → skip the AC ledger and Registry
  updates.

**AC-level persistent ledger:**
MODULE doc §3.4 is the source of truth at the AC level.
/dev SUMMARY reads the §3.4 tables of the affected MODULEs and writes this run's
verification results.
(§3.4 only records `passed` — DoD guarantees that by the time SUMMARY runs, every
in-scope AC has already passed, so there is no `failed` write path.)

**Registry status rules** (aggregated from §3.4 AC ledgers; only Active=Y rows count):
- On the IMPLEMENT commit → Registry Status: Spec'd → Implemented.
- During SUMMARY (executed by §6):
  1. Write this run's in-scope AC results into §3.4 → passed.
  2. Read all of the REQ's linked AC statuses from §3.4, **counting only Active=Y rows**:
     - All Active=Y AC passed → Registry: Verified
     - Some Active=Y AC passed + some untested → Partial
     - All Active=Y AC untested → keep as Implemented
     - Active=N ACs are fully excluded and do not affect any calculation.

State transitions remain: set `phase: "adversarial"` when entering 5.2; set
`phase: "summary"` once 5.3 is fully satisfied.

---

## Phase 6: SUMMARY

**Goal:** report results, update progress, clean up state.

### 6.1 Update implementation progress

> **Lightweight mode (`sdd_mode: false`): skip 6.1 and go straight to the report.**

- Update MODULE doc:
  - §3.1 Current Status (recomputed via the formula in §6.1.1 below)
  - §3.7 Change History (record this task)
  - §3.5 Feature Implementation Record is a hand-authored log and is NOT regenerated by this SUMMARY — it remains authored outside the progress pipeline.
- Update ARCHITECTURE.md's module progress overview as an **AC-weighted** aggregate: `sum(passed Active=Y AC across all modules) / sum(Active=Y AC across all modules) × 100`. AC-weighted (not per-module arithmetic mean) so that a 200-AC module at 50% doesn't get drowned out by a 1-AC module at 100%. Denominator-zero guard: if no module has Active=Y AC, display `—`.

#### 6.1.1 Computing progress

**Formula** (module-level progress, AC-driven):

```
module_progress_pct =
    count(AC in §3.4 where Active=Y AND Status='passed')
    / count(AC in §3.4 where Active=Y)
    × 100
```

Rounded to integer percent. The progress formula assumes §3.4 mirrors §1.5 (one `Active=Y`
row per current AC); /spec's merge-preserve rule at its §3.4 generation step guarantees
this post-`/spec`. If §1.5 is hand-edited without running `/spec`, the formula is still
well-defined but will undercount — run `/spec` to resync.

**Denominator-zero guard**: when the module has zero `Active=Y` AC rows, display `—`
and status `Not Started`. Do not emit `0%` (misleading — there's nothing to measure).
A `—` module means the module has not yet been speced with AC; run `/spec` to add AC
before trusting any progress number.

**§3.4 authorship contract**: the formula's integrity depends on §3.4 being mutated
only through the two authorized paths:
1. `/spec` (generation + rerun) — creates rows, flips `Active=Y↔N` on criterion change,
   merge-preserves unchanged rows.
2. `/dev` SUMMARY — flips `Status: untested → passed` for this task's in-scope AC IDs,
   fills `Verified By Task` and `Date` columns.

Hand-edits to §3.4 outside these paths (e.g., direct row additions during IMPLEMENT,
or `Status=passed` rows with no corresponding test run) are outside the progress
pipeline's contract and will produce meaningless percentages.

**Derived status** (replaces the old manually-flipped `{Draft / In Progress / Production}`
in §3.1):

| passed / active | Status |
|---|---|
| 0 / N (N > 0) | Not Started |
| 0 < passed < N | In Progress |
| N / N (N > 0) | Production |
| 0 / 0 | Not Started (denominator-zero guard) |

**Slice reminder**: progress is AC-driven. "Slice" is a task-organization term (thematic
batches of work), not a progress unit. Completing a slice contributes whatever ACs it
passed — no flat `+1%` per slice.

### 6.2 Report

**Strict template — whitelist only (fixes #27 #30)**: SUMMARY MUST be rendered strictly
with the fields below. It is **forbidden** to add any field that is not in the template
(for example "Known unfixed" / "Out-of-Scope" / "Deferred" / "TODO for you" /
"Known issues, logged for you" / "Known issues" / "Known gaps" / "Follow up later" /
"v2 deferred" / "Skip for now" — any flavour of free-form "leftover problem / unfixed"
field).

**The only legitimate "unfixed" recording path**: state.json's `deferred_findings` array
(every entry must carry a `user_accepted_at` timestamp, produced by the AskUserQuestion
accept-at-limit flow). Any substantive evaluator finding must take one of the following
three paths:
1. Fix + commit (the git diff MUST contain changes).
2. Roll back via branch (b)/(c)/(d) to an upstream phase.
3. After hitting max_round (10), the user explicitly accept-at-limits → write to
   deferred_findings.

**Field whitelist** (any field not in this list is forbidden in output):
Task / Modified files / Updated docs / Acceptance criteria / Independent evaluator
results / Requirement Traceability / Definition of Done / Cross-Module Regression /
Coverage boundary reminder / Progress change / Overall PRD progress /
Deferred Findings (only rendered when deferred_findings is non-empty; each entry comes
from state.json).

**Forbidden field examples** (their presence counts as a process violation):
~~Known unfixed~~ / ~~Known issues~~ /
~~Out-of-Scope (anything other than waived_scope formally declared in the plan)~~ /
~~Deferred work~~ / ~~TODO for you~~ / ~~Follow up later~~ / ~~Known gaps~~ /
~~v2 deferred~~ / ~~Needs follow-up design~~ / ~~Pending refinement~~ / ~~Skip for now~~

```
/dev task complete

Task:               {task_id}
Modified files:     {file list}
Updated docs:       {doc list}
Acceptance criteria:{checked}/{total}

Independent evaluator results (eval_history):
  Plan eval:        {plan_rounds} rounds, substantive {N} → ... → 0
  Audit eval:       {audit_rounds} rounds, substantive {N} → ... → 0 (doc: {N}, diff: {N})
  Test eval:        {test_rounds} rounds, pass_rate {X}% → ... → 100%
  Adversarial eval: {adversarial_rounds} rounds, substantive {N} → ... → 0

Requirement Traceability:
  REQ-IDs addressed: {REQ-001, REQ-005, ...}
  In-scope AC: {MODULE-001-AC-01, MODULE-001-AC-02, MODULE-003-AC-05}
  AC Tested: {ac_tested_rate}% | AC Passed: {ac_pass_rate}%

Definition of Done:
  Function: PASS | Testing: PASS | Security: PASS
  Code Quality: PASS | Doc Consistency: {PASS|SKIPPED}
  Traceability: {PASS|N/A (no registry)}
  Regression: {PASS (gate_status) | ⚠️ no_tested | ⚠️ no_historical_ac | no_downstream | degraded}
  Waived scope: {[descriptions] | none}

Cross-Module Regression (always render, branch by regression_gate_status — fixes #24, #26, 5 states):
  Gate status: {regression_gate_status}

  [if regression_gate_status == "degraded" (contract_registry_available == false):]
  N/A (no contract registry in ARCHITECTURE.md §6.1 — legacy v3.1.0 project or not upgraded)

  [otherwise (contract_registry_available == true) show context:]
  Modified contracts: {CONTRACT-001, ...}
  Affected downstream modules: {MODULE-003, MODULE-005 or "none"}
  Scope expansion: layers {scope_expansion_depth}, modules promoted: {scope_expansion list}

    [if regression_gate_status == "applicable":]
    Regression Tested: {regression_tested_rate*100}% | Regression Passed: {regression_pass_rate*100}%
    REGRESSION list: {AC list or "none"}
    NO_TEST_DEFINED: {list or "none"}
    NO_TEST_IMPLEMENTED: {list or "none"}

    [if regression_gate_status == "no_tested":]
    ⚠️  All {N} regression-scope AC are NO_TEST (AC declared but tests not implemented).
    Cross-module protection ineffective — relies entirely on test_cmd full pass_rate.

    [if regression_gate_status == "no_historical_ac":]
    ⚠️  {N} downstream module(s) affected ({affected_downstream_modules list})
    but none have historically verified AC (§3.4 all untested) — no regression scope
    built. Cross-module protection NOT available for this task;
    relies on test_cmd full pass_rate and manual review of downstream consumers.

    [if regression_gate_status == "no_downstream":]
    No downstream modules depend on modified_contracts — no cross-module impact.

Coverage boundary reminder (when regression_gate_status != "degraded"):
  Regression check only protects AC historically verified at least once (Status=passed in §3.4).
  Newly-defined AC and AC never verified are NOT covered — relies on test_cmd full pass_rate.
  Behavior-level regression (performance, side effects) is NOT covered — only signature-level.

[only render if state.json deferred_findings is non-empty:]
Deferred Findings (user-accepted at round limit — fix #29):
  - Round {N} [{severity}]: {description} (accepted {user_accepted_at})
  - ...
  REQ Status impact: {affected REQs} forced to Partial (cannot enter Verified)

Progress change: {module name} {old_progress}% → {new_progress}%
Overall PRD progress: {percentage}%
```

### 6.3 SUMMARY bookkeeping commit

If `in_scope_ac_ids` is non-empty:
1. Update the §3.4 AC Verification table of the affected MODULEs (this run's in-scope ACs
   → passed, fill in Verified By Task / Date).
2. Read the full set of Active=Y AC statuses for each REQ and update the Status column in
   `REQUIREMENTS_REGISTRY.md`:
   - All Active=Y AC passed → Verified
   - Some Active=Y AC passed + some untested → Partial
   - All Active=Y AC untested → keep as Implemented
3. SUMMARY bookkeeping commit — this commit is NOT audited. Strictly limit what is
   written:
   - §3.4 table: update only the Status column (untested → passed) and the
     Verified By Task / Date columns.
   - REGISTRY: update only the Status column and the Updated column.
   - No other edits are permitted.
   - Derive the affected MODULE doc list by reverse-lookup from `in_scope_ac_ids`
     (a unique set):
   ```bash
   git add docs/modules/MODULE-001-xxx.md docs/modules/MODULE-003-xxx.md docs/REQUIREMENTS_REGISTRY.md
   git commit -m "dev({task_id}): bookkeeping — update AC ledger and registry

   REQ: {REQ-001, REQ-005, ...}
   AC: {MODULE-001-AC-01, MODULE-001-AC-03, ...}"
   ```

If `in_scope_ac_ids` is empty (pure waived-scope task): skip the §3.4 / Registry updates
and the bookkeeping commit.

### 6.4 Cleanup

Delete `state.json`.
