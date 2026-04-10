---
name: dev
version: 3.2.0
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
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-phase.sh"
          statusMessage: "Checking dev workflow phase..."
    - matcher: "Write"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-phase.sh"
          statusMessage: "Checking dev workflow phase..."
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-phase.sh"
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
- **Progress tracking**: after every completed task, update §14 implementation progress.
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

**Note**: the Bash tool must be called with `timeout: 300000` (5 minutes).

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
   - Codex background Bash (timeout: 300000) must wait for the task-notification before reading
     stdout; reading before completion yields null.

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

Codex Evaluator (Bash tool, codex exec, timeout: 300000):
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
- Read any affected MODULE docs (especially §14 to understand current progress).
- Read the relevant source code.
- Read the relevant sections of PRD.md and ARCHITECTURE.md.

### 1.2 Produce a structured plan

The plan must contain:
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

  ② Codex Plan Evaluator (Bash tool, codex exec, timeout: 300000)
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

**ARCHITECTURE.md** (for architecture changes; also update the module progress overview)

**Affected MODULE-xxx.md** — update any affected section as needed:
- §1 Module goals (when the task changes them)
- §2 Module boundaries IN/OUT (when responsibilities change)
- §3 Dependencies (when upstream/downstream deps are added or changed)
- §4 Interface definitions (when interface signatures change)
- §5 Data models (when data structures change)
- §6 Core logic (when business flows change)
- §7 Error handling (when new error types are added)
- §8 State management (when state transitions change)
- §9 Security considerations (when security requirements change)
- §10 Performance requirements (when performance metrics change)
- §11 Acceptance criteria — **MUST** add checkbox entries for this task
- §12 Test cases — **MUST** design comprehensive test cases for this task
- §13 Implementation notes (when the implementation approach changes)
- §14 Implementation progress — maintain the feature list (single source of truth):
  - New feature → status "🔲 not started"
  - Removed feature → remove from list
  - Modified feature → update description, keep original status
  - Record this change in §14.3 change history

If a new module is needed, create it in full from the `/spec` §14 template (update the
allowlist first).

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

- Follow the interface definitions (§4) and implementation notes (§13) in the MODULE docs.
- Code incrementally per the implementation steps in the PLAN.
- Implement the test cases defined in MODULE §12.

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

  ② Codex Doc Evaluator (Bash tool, codex exec, timeout: 300000)
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

  ④ Codex Diff Evaluator (Bash tool, codex exec, timeout: 300000)
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

  ② Codex Test Evaluator (Bash tool, codex exec, timeout: 300000)
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
    b) Fix changes the interface (§4) / acceptance criteria (§11) / scope (§2 / §14) /
       data model (§5) → roll back to DOCS: set state.json phase: "docs".
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

  ② Codex Adversarial Evaluator (Bash tool, codex exec, timeout: 300000)
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

- Update MODULE doc §14:
  - 14.1 overall status and progress percentage
  - 14.2 feature implementation log (mark the features completed this task)
  - 14.3 change history (record this task)
- Update ARCHITECTURE.md's module progress overview.
- Recompute progress percentages.

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
