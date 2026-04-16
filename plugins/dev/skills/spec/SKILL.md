---
name: spec
version: 3.2.0
description: |
  Generate architecture and module specification documents from PRD.
  MECE module decomposition, self-contained specs for AI agent implementation.
  Independent evaluator architecture: PRD coverage evaluator ensures zero requirements lost.
  Supports greenfield and existing project modes.
  Usage: /spec [path/to/PRD.md or path/to/prd-directory/]
  Trigger when user asks to "generate specs", "generate architecture", "decompose modules",
  "generate module docs", "spec", or "specification driven development".
argument-hint: "[PRD path] or resume|abort|status"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - Agent
---

# /spec: Specification Driven Development

You are a senior software architect. Your task is to execute the complete /spec workflow based on
PRD (Product Requirements Documents): analyze requirements → design architecture → generate
module specifications → determine implementation order.

**Core Principles:**
- **MECE**: Module decomposition must be Mutually Exclusive and Collectively Exhaustive
- **Self-contained**: Each module spec includes sufficient context for independent AI Agent implementation
- **Explicit dependencies**: Inter-module dependencies must be clearly labeled
- **Independent evaluators**: Architecture and Module specs are validated by fresh evaluators (Claude + Codex) checking PRD coverage, MECE compliance, interface consistency — convergence = zero substantive findings
- **English output**: All generated documents use English

**Iron Rule — No Escape Hatch (fixes #27 and #30; a global constraint across /dev and /spec):**

It is forbidden, in any phase output (ARCHITECTURE.md / MODULE-*.md / Final Report /
the plan inside an AskUserQuestion), to invent any of the following fields:
- "Known gaps" / "Known issues" / any "not yet aligned" free-form field
- "TODO" / "TODO: …" / "To be addressed later" / "Pending refinement"
- "Out of scope" (other than OUT-xxx formal scope exclusions)
- "Deferred work" / "v2 deferred" / "follow up later"
- "Needs follow-up design"
- Any other free-form wording (in any language) that routes around evaluator findings.

Every substantive finding (Critical + Warning) reported by the evaluators MUST take
one of the following paths:
1. **Fix**: edit ARCHITECTURE.md / MODULE-*.md directly; the next evaluator round
   re-checks it.
2. **Roll back to an upstream phase**: if the PRD itself is ambiguous or incomplete,
   use AskUserQuestion to make the user update the PRD. /spec is NOT allowed to
   "ghostwrite" open PRD questions.
3. **Explicit abort**: run `/spec abort` to terminate the run. Half-finished
   "let's call it done" is not allowed.

The only legitimate "not implemented" marker is §3.6 Known Gaps & Future Work
(present in the MODULE template), and it may be used **only** to record known
boundaries of already-implemented functionality (for example, "v1 supports
PostgreSQL only; the MySQL adapter ships in v2"). It **must not** be used to
route around the current round's evaluator findings.

LLM agents have a natural tendency to soften hard constraints with free-form text —
this rule explicitly forbids that escape hatch.

**Design note: /spec vs /dev enforcement model**

/spec does NOT use PreToolUse hooks or check-phase.sh. Gates use AskUserQuestion (blocking call). Evaluator loops are instruction-level, not hook-enforced. This means /spec's phase discipline is a convention, not an enforced invariant — the agent CAN write outside `docs/` or skip a gate. This is a deliberate trade-off: /spec's risk profile (writing markdown docs) is lower than /dev's (modifying source code), so the lighter enforcement is acceptable.

---

## Phase 0: Initialization

### 0.0 Sub-command Dispatch (early return)

Parse `$ARGUMENTS` FIRST, before any other initialization:
- `resume` → read `docs/.spec-state/progress.json`, continue from current phase (skip to resume logic below)
- `abort` → delete `docs/.spec-state/`, output "workflow aborted", exit
- `status` → read and display `docs/.spec-state/progress.json` summary, exit
- anything else → treat as PRD path, proceed to 0.1

### 0.1 Dependency Check

```bash
echo "=== /spec dependency check ==="
which jq 2>/dev/null && echo "JQ: OK" || echo "JQ: MISSING (evaluator output parsing)"
which codex 2>/dev/null && echo "CODEX: OK" || echo "CODEX: MISSING (single-evaluator mode)"
[ -f "$HOME/.claude/agents/claude-auditor.md" ] && echo "AUDITOR: OK" || echo "AUDITOR: MISSING"
```

- `jq` missing → set `codex_available: false` (Codex evaluator pipeline depends on jq for JSON parsing)
- `codex` missing → set `codex_available: false`
- Either case: evaluators run Claude-only (single-evaluator mode), warn user
- `claude-auditor` missing → error, evaluator loops cannot function. Abort or run without evaluators (user choice via AskUserQuestion)

### 0.1 Locate PRD File(s)

```bash
PRD_PATH="${ARGUMENTS:-}"

# Search for PRD by priority
if [ -n "$PRD_PATH" ] && [ -f "$PRD_PATH" ]; then
  echo "FOUND: $PRD_PATH"
elif [ -n "$PRD_PATH" ] && [ -d "$PRD_PATH" ]; then
  echo "FOUND_DIR: $PRD_PATH"
  ls "$PRD_PATH"/*.md 2>/dev/null
elif [ -d "docs/00-prd" ]; then
  PRD_PATH="docs/00-prd"
  echo "FOUND_DIR: docs/00-prd"
  ls docs/00-prd/*.md 2>/dev/null
elif [ -f "docs/PRD.md" ]; then
  PRD_PATH="docs/PRD.md"
  echo "FOUND: docs/PRD.md"
elif [ -f "PRD.md" ]; then
  PRD_PATH="PRD.md"
  echo "FOUND: PRD.md"
else
  echo "NOT_FOUND"
  echo "Searching for possible PRD files..."
  find . -maxdepth 3 -iname "*prd*" -o -iname "*requirement*" -o -iname "*overview*" 2>/dev/null | head -10
fi
```

- If output is `NOT_FOUND` and no candidate files found, use AskUserQuestion to ask the user for the PRD file path.
- If `FOUND_DIR`, read all `.md` files in the directory as a multi-PRD project.
- If candidate files found, list them and let the user confirm.

### 0.2 Check Existing Documents

```bash
echo "=== Checking existing spec documents ==="
[ -f "docs/ARCHITECTURE.md" ] && echo "EXISTS: docs/ARCHITECTURE.md" || echo "MISSING: docs/ARCHITECTURE.md"
[ -d "docs/modules" ] && echo "EXISTS: docs/modules/ ($(ls docs/modules/*.md 2>/dev/null | wc -l) module docs)" || echo "MISSING: docs/modules/"
[ -f "docs/IMPLEMENTATION_ORDER.md" ] && echo "EXISTS: docs/IMPLEMENTATION_ORDER.md" || echo "MISSING: docs/IMPLEMENTATION_ORDER.md"
[ -f "docs/.spec-state/progress.json" ] && echo "ACTIVE_WORKFLOW: YES" || echo "ACTIVE_WORKFLOW: NO"
```

- If existing documents found, use AskUserQuestion to ask the user:
  - "Existing spec documents detected. Please choose: (1) Regenerate all (2) Update changed parts only (3) Cancel"
- Ensure `docs/` and `docs/modules/` directories exist (create when writing later).
- Remove stale `docs/overview.md` check — this file is not generated by /spec.

### 0.3.1 State Tracking (progress.json)

```bash
mkdir -p docs/.spec-state
grep -q '.spec-state' .gitignore 2>/dev/null || echo 'docs/.spec-state/' >> .gitignore
```

Write `docs/.spec-state/progress.json`:
```json
{
  "phase": "init",
  "prd_paths": [],
  "mode": "greenfield|existing_project",
  "codex_available": true,
  "codex_consecutive_failures": 0,
  "degraded_from_round": null,
  "architecture_done": false,
  "architecture_eval_rounds": 0,
  "architecture_claude_rounds_run": 0,
  "architecture_codex_rounds_run": 0,
  "architecture_accepted_at_round": null,
  "modules_completed": {},
  "modules_accepted": {},
  "modules_in_progress": {},
  "modules_total": 0,
  "updated_at": "ISO 8601"
}
```

**Update protocol** (update progress.json at each transition):
- After Gate 1 confirmed → `phase: "architecture"`
- After Architecture Evaluator converges → `architecture_done: true`, `architecture_eval_rounds: N` (leave `architecture_accepted_at_round: null`)
- After user accepts architecture at round limit → `architecture_done: true`, `architecture_eval_rounds: N`, `architecture_accepted_at_round: N`
- After Gate 2 confirmed → `phase: "modules"`, `modules_total: N`
- Before starting each module → add to `modules_in_progress` as `{"MODULE-NNN-name": {"eval_round": 0, "claude_rounds_run": 0, "codex_rounds_run": 0}}`
- After each evaluator round → increment `modules_in_progress["MODULE-NNN-name"].eval_round`, plus `claude_rounds_run` (always) and `codex_rounds_run` (only if Codex participated this round per Sync Protocol rule 4)
- After each module evaluator converges → move from `modules_in_progress` to `modules_completed` as `{"MODULE-NNN-name": {"eval_rounds": N}}`
- After user accepts module at round limit → move from `modules_in_progress` to `modules_accepted` as `{"MODULE-NNN-name": {"eval_rounds": N}}`
- All modules done → `phase: "implementation_order"` (set BEFORE starting Phase 3 generation)
- After Phase 3 complete → `phase: "report"`
- After Phase 4 report → delete `docs/.spec-state/`

**User-accepts-at-limit protocol**: when evaluator exceeds max rounds and user chooses "accept current":
- Architecture: set `architecture_done: true`, `architecture_accepted_at_round: N` (converged leaves this `null`)
- Module: move from `modules_in_progress` to `modules_accepted` (NOT `modules_completed`)
- Both cases: proceed to next phase. Resume treats `modules_accepted` same as `modules_completed` (no re-entry)
- Final report uses `architecture_accepted_at_round != null` → "accepted at round N", else "converged in N rounds"
- Final report checks each module: in `modules_accepted` → "accepted", in `modules_completed` → "converged"

**Heartbeat**: update `updated_at` at each evaluator round.

**Resume logic**: read `phase` and fields to determine where to continue:
- `phase: "architecture"` + `architecture_done: false`:
  - If `docs/ARCHITECTURE.md` exists → resume from Phase 1.3 evaluator
  - If `docs/ARCHITECTURE.md` missing → re-run Phase 1 from 1.2 generation
- `phase: "architecture"` + `architecture_done: true` → resume from Phase 1.4 Gate 2
- `phase: "modules"`:
  - Skip `modules_completed` and `modules_accepted` (both are done — no re-entry)
  - For each entry in `modules_in_progress`: check if MODULE file exists → yes: resume evaluator at `eval_round` from state, no: re-generate
  - Continue with remaining modules not in either list
- `phase: "implementation_order"`:
  - If `docs/IMPLEMENTATION_ORDER.md` exists → skip to Phase 4 report
  - If missing → re-run Phase 3
- `phase: "report"` → re-run Phase 4 final report

**`/spec status` output format**:
```
/spec workflow status

Phase: {phase}
Mode: {mode}
PRD: {prd_paths}
Codex: {codex_available}
Architecture: {architecture_done} ({converged in {architecture_eval_rounds} rounds | accepted at round {architecture_accepted_at_round}})
Modules: {len(modules_completed)} converged, {len(modules_accepted)} accepted, {len(modules_in_progress)} in progress / {modules_total} total
Last updated: {updated_at}
```

### 0.3 Detect Project Mode

```bash
echo "=== Detecting project mode ==="
# Check for ANY source code files (language-agnostic)
SRC_COUNT=$(find . -maxdepth 4 -type f \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.swift" -o -name "*.kt" \) -not -path "*/node_modules/*" -not -path "*/.venv/*" -not -path "*/vendor/*" 2>/dev/null | wc -l)
if [ "$SRC_COUNT" -gt 0 ]; then
  echo "MODE: existing_project (${SRC_COUNT} source files found)"
  echo "Top-level directories:"
  ls -d */ 2>/dev/null
else
  echo "MODE: greenfield"
fi
```

- **Greenfield mode**: Standard flow — PRD → Architecture → Module specs
- **Existing project mode**: Use Glob and Grep tools to explore the actual codebase structure (do NOT rely on hardcoded directory names). Cross-reference discovered code with PRD.
  - **Scope limitation**: Module specs describe what the module SHOULD do (from PRD) and note which existing files are relevant. Do NOT promise to document every file or every method — the evaluator checks PRD coverage, not source code completeness.

### 0.4 Read PRD(s)

Use Read tool to read all PRD files completely. If a file exceeds 2000 lines, read in segments.

After reading, summarize internally:
- Product name and positioning
- Core feature list
- User roles/personas
- Non-functional requirements (performance, security, availability, etc.)
- Technical constraints (if specified)
- Scope boundaries (explicit out-of-scope list)
- **For existing projects**: Map each PRD to discovered source modules

### 0.4.1 Requirement ID Assignment (Traceability)

After reading all PRDs, assign a unique ID to every discrete requirement, feature, constraint,
and non-functional requirement. Format: `REQ-{NNN}` (three-digit, zero-padded).

Write the requirement registry to `docs/REQUIREMENTS_REGISTRY.md`:

**In-Scope Requirements** (only Active=Y participate in coverage calculation):

| REQ ID | Active | Source | Section | Description | Type | Module(s) | Status | Updated |
|--------|--------|--------|---------|-------------|------|-----------|--------|---------|
| REQ-001 | Y | PRD.md | §2.1 | {description} | Feature | {after Phase 1} | Draft | {date} |
| REQ-002 | Y | PRD.md | §3.1 | {description} | NFR | {after Phase 1} | Draft | {date} |

Active: Y (current) / N (deprecated — excluded from coverage, evaluator, and aggregation)
Type: Feature / NFR (Non-Functional Requirement) / Constraint
Status: Draft → Spec'd → Implemented → Verified | Partial
  - Draft: identified in PRD but not yet assigned to a module
  - Spec'd: assigned to module(s), MODULE spec generated
  - Implemented: code implementation complete (/dev IMPLEMENT commit)
  - Verified: all Active=Y AC for this REQ have passed (/dev SUMMARY)
  - Partial: some Active=Y AC passed, some still untested (/dev SUMMARY)

**Scope Exclusions** (explicitly out-of-scope, NOT counted in coverage):

| REQ ID | Source | Description | Reason |
|--------|--------|-------------|--------|
| OUT-001 | PRD.md §5 | {excluded item} | {why excluded} |

The `Module(s)` column is populated after ARCHITECTURE.md is generated (Phase 1).
Coverage = Active=Y REQ-IDs with module mapping / total Active=Y REQ-IDs. Target: 100%.

**REQ-ID stability rules (for /spec reruns):**
- Existing REQ-IDs with unchanged Description: PRESERVE original ID
- Existing REQ-IDs with changed Description (semantically different requirement):
  → Set old REQ Active=N, assign new REQ-{next} with Active=Y
- New requirements (not in existing registry): assign next available REQ-{NNN}
- Removed requirements (no longer in PRD): set Active=N
- Never reuse deprecated REQ-IDs

### 0.5 Confirm Understanding with User (Gate 1)

Present the PRD understanding summary to the user:

```
PRD Understanding Confirmation

Product: {product name}
Positioning: {one-line description}
Mode: {greenfield | existing project}

Core Features:
  1. {feature 1}
  2. {feature 2}
  ...

User Roles: {role list}
Technical Constraints: {constraint list}
Scope Boundaries: {explicitly out-of-scope items}

{For existing projects:}
Detected Source Modules: {list}
PRD-to-Code Mapping:
  {PRD name} → {source module(s)}
  ...
Discrepancies Found: {list any PRD content that doesn't match source code}

Please confirm whether this understanding is correct, or point out corrections needed.
```

**Spec Review (Developer Perspective):** Before presenting to user, challenge each core feature:

- **Empty/null states**: What happens when key fields are empty, null, or missing?
- **State coexistence**: Can any two states coexist? What resolves conflicts?
- **Network failure**: Behavior under weak, intermittent, or no network?
- **Concurrency**: Concurrent modification of the same resource — strategy?
- **Scale boundaries**: Behavior at extreme data volumes? Pagination?
- **Time zones / i18n**: Multi-timezone or multi-language requirements implied but unstated?
- **Migration**: For existing projects — data migration path from current state?

Append to Gate 1 output:
```
Ambiguities Found (Developer Perspective):
  1. {REQ-NNN}: {ambiguity} — Assumed: {assumption}
  Items requiring user clarification: {list}
```

If critical ambiguities exist, ask user to resolve before proceeding.

Use AskUserQuestion to wait for user confirmation. If user has corrections, update understanding and continue.

---

## Dual-Evaluator Sync Protocol (Fix #31 v3.3 — applies to all evaluator loops: Phase 1.3 Architecture, Phase 2.4 Module)

The following 5 hard constraints are **shared** by every evaluator loop in /spec. Violating any one is treated as a process violation and the main agent must stop and report.

1. **Parallel spawn enforcement (single-message rule)**
   - In STEP 1, the Claude Agent call and Codex Bash call **must be fired in the same assistant response**, side-by-side. Sequential spawning (Claude first, wait, then Codex) is forbidden.
   - Do NOT branch on "let me check Claude's result before deciding whether to run Codex".
   - If preparatory work is needed (read files, compute inputs), do it in a **separate** response first, then use **one dedicated response** to fire both evaluators simultaneously.
   - Violation (sequential spawn) → Codex is treated as "did not participate this round" and `eval_round` does NOT advance.

2. **STEP 2 barrier assertion**
   - Before entering STEP 2, both of the following must hold:
     a. `claude_result != null AND format_valid(claude_result)`
     b. `codex_result != null AND format_valid(codex_result)` **OR** `codex_available == false` (in degraded mode only check a)
   - If either fails (output missing, empty, malformed) → STEP 2 is **forbidden**; handle per rule 3.
   - Codex foreground Bash (`timeout: 600000`, blocking): the Bash tool does NOT return until `codex exec` exits, so stdout is safe to read immediately on return. **Do NOT pass `run_in_background: true`** — see the "Known bug workaround" note near the Codex command template.

3. **Mid-flight degradation protocol**
   - Within a single round, if Codex returns failure/timeout/empty → retry Codex **once in the same round** (Claude's result is cached, do NOT re-run Claude).
   - If retry also fails → `codex_consecutive_failures += 1`; merge only Claude's findings for this round, but `eval_round` advances normally.
   - **Two consecutive round failures** → force **degraded mode**:
     - `codex_available: false` in state file
     - `degraded_from_round: {eval_round}` recorded
     - All subsequent rounds skip Codex, mark as "single-evaluator"
     - **Degradation is irreversible** within the same spec run.
   - Any round where Codex succeeds → reset `codex_consecutive_failures = 0`.

4. **Per-evaluator counters + invariant**
   - State file maintains `claude_rounds_run` / `codex_rounds_run` (per architecture eval and per module eval).
   - After each STEP 2 merge completes:
     - `claude_rounds_run += 1` (always)
     - `codex_rounds_run += 1` (only if Codex's output was valid and participated in merge this round)
   - **Invariant** (main agent must assert this before writing STEP 3):
     - `claude_rounds_run == eval_round`
     - `codex_rounds_run == eval_round` **OR** `(codex_available == false AND codex_rounds_run == degraded_from_round - 1)`
   - Invariant violation → stop the loop and AskUserQuestion to report process failure. Do NOT silently advance.

5. **Rescue bypass isolation + narration discipline**
   - `codex:codex-rescue` subagent calls are **rescue side-channels** — they do **NOT** count toward `codex_rounds_run` and do **NOT** get written to `eval_history`.
   - All narration output (progress reports, Final Report, evaluator prompt round hints) **must NOT** use "Claude round X / Codex round Y" phrasing — always use the single unified `eval_round`.
   - To report an evaluator's per-round finding count, reference `eval_history[-1].claude_findings` / `codex_findings` fields — do not expose separate round numbers.

---

## Phase 1: Generate ARCHITECTURE.md

### 1.1 Module Decomposition (MECE Principle)

Based on PRD analysis (and source code scan for existing projects), decompose the system into
mutually exclusive and collectively exhaustive modules. Consider:

**Decomposition dimensions (by priority):**
1. **Business domain boundaries**: Decompose by business capability/domain (preferred)
2. **Technical layer boundaries**: Frontend/backend/data/infrastructure
3. **Change frequency**: Separate frequently changing parts from stable parts
4. **Team boundaries**: Granularity suitable for independent development

**For existing projects:** Module decomposition should reflect the actual code structure. Each discovered
source module should map to a MODULE spec. Merge or split only when the actual structure is clearly
suboptimal.

**MECE Checklist:**
- Every requirement is covered by exactly one module (Exhaustive)
- No two modules have overlapping responsibilities (Exclusive)
- Module granularity is appropriate: not too large (>1 week) nor too small (<2 hours)
- Each module has a clear single responsibility

**Module naming convention:**
- Use lowercase English + hyphens: `user-auth`, `data-pipeline`, `notification-service`
- Module document numbering format: `MODULE-{three-digit-number}-{module-name}` e.g. `MODULE-001-user-auth`

**Module ID stability (for reruns / update mode):**
- Existing modules: MUST keep their original MODULE-{NNN} ID, even if order changes
- New modules: assign the next available number (max existing + 1), never reuse deprecated IDs
- Merged modules: keep the lower ID, deprecate the higher one
- Split modules: original keeps its ID for the larger part, new split gets a new ID
- This ensures AC IDs (MODULE-NNN-AC-xx) and Test IDs (MODULE-NNN-Txx) remain stable across reruns

### 1.2 Architecture Document Structure

Use Write tool to generate `docs/ARCHITECTURE.md` with the following structure:

```markdown
# Architecture Design Document

> Project: {project name}
> Version: 1.0.0
> Generated: {date}
> Based on: {PRD file path(s)}

---

## 1. Architecture Overview

{1-2 paragraphs describing overall architecture style and design philosophy}

## 2. Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| ... | ... | ... |

## 3. Module Inventory

| Module ID | Module Name | Responsibility | Spec Document |
|-----------|-------------|---------------|---------------|
| MODULE-001 | {module name} | {one-line responsibility} | [MODULE-001-{name}](modules/MODULE-001-{name}.md) |
| MODULE-002 | {module name} | {one-line responsibility} | [MODULE-002-{name}](modules/MODULE-002-{name}.md) |

### 3.1 MECE Verification

{Explain how module decomposition satisfies MECE:
  - Exhaustiveness: Each PRD requirement → corresponding module
  - Exclusivity: Responsibility boundaries between each pair of modules}

## 4. Dependency Graph

\```mermaid
graph TD
    A[Module A] --> B[Module B]
    A --> C[Module C]
    B --> D[Module D]
    C --> D
\```

### 4.1 Dependency Matrix

| Module | Depends On | Depended By |
|--------|-----------|-------------|
| ... | ... | ... |

### 4.2 Dependency Principles
- No circular dependencies
- Dependency direction: Business layer → Service layer → Infrastructure layer
- Interface dependency preferred over implementation dependency

## 5. Data Flow

\```mermaid
sequenceDiagram
    participant U as User
    participant A as Module A
    participant B as Module B
    participant DB as Database
    U->>A: Request
    A->>B: Call
    B->>DB: Query
    DB-->>B: Return
    B-->>A: Result
    A-->>U: Response
\```

{Describe main data flow paths}

## 6. Interface Definitions

### 6.1 Inter-module Contract Registry

| Contract ID | Active | Provider Module | Consumer Module(s) | Description |
|-------------|--------|----------------|-------------------|-------------|
| CONTRACT-001 | Y | MODULE-001 | MODULE-003, MODULE-005 | OAuth token issuance interface |
| CONTRACT-002 | Y | MODULE-002 | MODULE-003 | Event publishing schema v1 |

Active: Y (current) / N (deprecated)
Contract ID format: `CONTRACT-{NNN}` (three-digit, zero-padded)

**Contract stability rules** (mirrors REQ/Module/AC):
- Existing contract with unchanged signature: PRESERVE ID
- Contract signature semantically changed: set old Active=N, allocate new CONTRACT-{next}
- New contracts: assign next available number
- Removed contracts: Active=N (do not delete)

### 6.2 External Interfaces

{System-exposed APIs/interfaces}

## 7. Non-functional Requirements Mapping

| Non-functional Requirement | Implementation Strategy | Responsible Module |
|---------------------------|------------------------|-------------------|
| ... | ... | ... |

## 8. Key Decision Records

### Decision 1: {Decision Title}
- **Problem**: {problem faced}
- **Options**: {alternatives considered}
- **Decision**: {final choice}
- **Rationale**: {why}

## 9. Risk Register

| ID | Risk | Impact | Probability | Mitigation | Owner Module |
|----|------|--------|-------------|------------|-------------|
| RISK-001 | {description} | High/Med/Low | High/Med/Low | {strategy} | MODULE-{NNN} |

Risk dimensions: module complexity, external dependency stability, cross-module integration,
performance-critical path with strict SLA.

## 10. Requirement Traceability

| REQ ID | Module(s) | Architecture Section |
|--------|-----------|---------------------|
| REQ-001 | MODULE-001 | §3 Module Inventory |

(Every Active=Y REQ-ID from REQUIREMENTS_REGISTRY.md must appear. OUT-xxx and Active=N excluded.)

## 11. Threat Model

### 11.1 Attack Surfaces

| Surface | Entry Points | Data at Risk | Responsible Module |
|---------|-------------|-------------|-------------------|
| {e.g. Public API} | {endpoints} | {user PII, tokens} | MODULE-{NNN} |

### 11.2 STRIDE Analysis (for modules handling auth/payment/PII)

| Module | Threat | Category | Mitigation | Priority |
|--------|--------|----------|-----------|----------|
| MODULE-{NNN} | {threat description} | S/T/R/I/D/E | {control measure} | High/Med/Low |

### 11.3 Security Control Decisions

- {Decision 1: e.g. "All API endpoints require JWT auth, except /health"}
- {Decision 2: e.g. "PII encrypted at rest using AES-256"}
```

### 1.3 Architecture Evaluator Loop (Independent Evaluator Architecture)

After generating ARCHITECTURE.md, use independent evaluators to verify PRD coverage before presenting to user.

**Immutable spec**: PRD.md. **Mutable output**: ARCHITECTURE.md. **Convergence**: uncovered_count == 0 AND substantive_count == 0.

```
eval_round = 0

repeat:
  eval_round += 1

  ──────────────────────────────────────────────────────────────
  STEP 1: Spawn TWO fresh Architecture Evaluators in parallel
  (Per Dual-Evaluator Sync Protocol rule 1: Claude Agent call + Codex Bash
   MUST be fired in the SAME assistant response, not sequentially.)
  ──────────────────────────────────────────────────────────────

  ① Claude Architecture Evaluator (Agent, subagent_type: claude-auditor)
     prompt:
       "You are an independent architecture evaluator. Round {eval_round}.
        You have ZERO knowledge of how this architecture was designed.

        PRD file(s): {prd_paths}
        Architecture doc: docs/ARCHITECTURE.md

        Read BOTH documents. For every requirement, feature, constraint, and
        non-functional requirement in the PRD, verify it maps to a specific module.
        Check MECE compliance and dependency soundness.
        Also check: Risk Register (§9) exists with entries for high-risk modules.
        Threat Model (§11) exists with attack surfaces and STRIDE for auth/payment/PII modules.
        Missing risk register → Warning. Missing threat model for sensitive modules → Critical.

        Also check Contract Registry (§6.1) internal consistency only — DO NOT verify
        cross-document references (module docs are not yet generated at this phase):
        - Each Contract's Provider Module must exist in §3 Module Inventory
        - Provider and Consumer cannot be the same module
        - Each Consumer Module must exist in §3 Module Inventory
        - Contract IDs are unique and follow CONTRACT-{NNN} format
        - Active=Y/N column is present
        Cross-doc reference checks (§6.1 ↔ §2.2/§2.3) are delegated to Module Evaluator
        in Phase 2.4 when module docs are available.

        Output format (MANDATORY):
        Architecture Evaluation: Round {eval_round}
        PRD Coverage: {covered}/{total} ({rate}%)
        Uncovered Items:
        1. [Critical] PRD §{section} ... — not mapped to any module
        MECE Violations:
        1. [Critical/Warning] ...
        Dependency Issues:
        1. [Critical/Warning] ...
        Risk & Threat Model Issues:
        1. [Critical/Warning] ...
        Substantive Findings: {Critical + Warning count}
        Verdict: PASS | FAIL"

  ② Codex Architecture Evaluator (Bash, codex exec, timeout: 600000)
     prompt: "[PLAN MODE — DEEP REVIEW] Before reviewing, create a review plan. Phase 1: identify all review dimensions. Phase 2: execute systematically. Phase 3: synthesize findings with severity levels and verdict." +
       "Independent architecture evaluator. Round {eval_round}.
        Read PRD: {prd_paths}. Read: docs/ARCHITECTURE.md.
        For EVERY requirement in PRD, check if a module covers it.
        Check MECE (no overlaps, no gaps). Check dependencies (no cycles).
        Also check: Risk Register (§9) exists with entries for high-risk modules.
        Threat Model (§11) exists with attack surfaces and STRIDE for auth/payment/PII modules.
        Missing risk register → Warning. Missing threat model for sensitive modules → Critical.

        Also check Contract Registry (§6.1) internal consistency only:
        - Each Contract's Provider Module exists in §3 Module Inventory
        - Provider != Consumer
        - Each Consumer Module exists in §3 Module Inventory
        - Contract IDs unique, follow CONTRACT-{NNN} format, has Active=Y/N column
        Cross-doc references (§6.1 ↔ §2.2/§2.3) are checked by Module Evaluator at Phase 2.4.

        YOUR FINAL OUTPUT MUST USE THIS EXACT FORMAT (mandatory):
        Architecture Evaluation: Round {eval_round}
        PRD Coverage: {covered}/{total} ({rate}%)
        Uncovered Items:
        1. [Critical] PRD §{section} ... — not mapped to any module
        MECE Violations:
        1. [Critical/Warning] ...
        Dependency Issues:
        1. [Critical/Warning] ...
        Risk & Threat Model Issues:
        1. [Critical/Warning] ...
        Substantive Findings: {Critical + Warning count}
        Verdict: PASS | FAIL

        Use ONLY Critical/Warning/Info severity levels. Do NOT use High/Medium/Low."
     Command:
     ```
     codex exec "<prompt above>" \
       -C "$(git rev-parse --show-toplevel)" \
       -s read-only \
       -c 'model_reasoning_effort="high"' \
       --json 2>/dev/null | jq -r --unbuffered '
         if .type == "item.completed" and .item then
           if .item.type == "agent_message" and .item.text then .item.text
           else empty end
         elif .type == "turn.completed" and .usage then
           "tokens: " + ((.usage.input_tokens // 0) + (.usage.output_tokens // 0) | tostring)
         else empty end
       '
     ```
     Bash timeout: 600000. Run in **foreground** — do NOT set `run_in_background: true`.

     **Known bug workaround — Codex must run in foreground** (anthropics/claude-code#21048):
     Claude Code 2.1.19+ has a regression where background Bash task completion notifications
     frequently fail to fire, leaving the main agent stuck on
     `Churned for Nm Ks · 1 shell still running` until the user manually sends another
     message. To side-step this entirely, every `codex exec` call in this skill is fired
     with `timeout: 600000` (10 min) as a foreground Bash call. The Bash tool does not
     return until `codex exec` exits, so stdout is safe to read immediately — no
     task-notification race. Do NOT revert to background execution until upstream confirms
     the regression is fixed (still reproducing on 2.1.101 as of 2026-04-11).

  Fallback: codex not available → Claude only, mark as single-evaluator.

  **IMPORTANT: Wait for BOTH evaluators to complete before proceeding.**
  The Codex Bash command runs in the **foreground** (`timeout: 600000`, blocking;
  **do NOT** set `run_in_background: true`). The Bash tool does not return until
  `codex exec` exits, so stdout is safe to read immediately on return. See the
  "Known bug workaround" note near the Codex command template for context.
  Do NOT proceed to STEP 2 until both evaluator outputs are fully available.

  ──────────────────────────────────────────────────────────────
  STEP 2: Merge evaluator reports
  ──────────────────────────────────────────────────────────────
  **Barrier assertion (Sync Protocol rule 2)**: before entering STEP 2, all of the
  following must hold:
    - claude_result is returned AND format is valid
    - codex_result is returned AND format is valid, OR codex_available == false
  If either fails → apply Sync Protocol rule 3 (retry Codex once in same round,
  Claude's cached result is reused — do NOT re-run Claude).
  Two consecutive rounds of Codex failure → force degraded mode:
    - codex_available = false
    - degraded_from_round = eval_round
    - all subsequent rounds skip Codex, mark as single-evaluator


  - Merge uncovered PRD items (union)
  - Merge MECE violations and dependency issues (deduplicate)
  - Merge Risk & Threat Model Issues (deduplicate)
  - Both found same issue → high confidence
  - Only one found → main agent arbitrates

  ──────────────────────────────────────────────────────────────
  STEP 2.5: Per-evaluator counter update + invariant (Sync Protocol rule 4)
  ──────────────────────────────────────────────────────────────
  After merge completes, update progress.json:
    architecture_claude_rounds_run += 1  (always)
    if codex participated this round and output was valid:
      architecture_codex_rounds_run += 1
  Assert invariants before writing step 3 results:
    architecture_claude_rounds_run == eval_round
    architecture_codex_rounds_run == eval_round OR
      (codex_available == false AND architecture_codex_rounds_run == degraded_from_round - 1)
  Invariant violation → stop the loop and AskUserQuestion to report process failure.

  ──────────────────────────────────────────────────────────────
  STEP 3: Verdict
  ──────────────────────────────────────────────────────────────

  If PRD coverage == 100% AND substantive_count == 0 → converged, exit loop

  If findings exist:
  - Main agent revises ARCHITECTURE.md based on evaluator report
  - Back to STEP 1 (fresh evaluators)

  > 10 rounds → AskUserQuestion (accept current / keep refining / abort)
```

### 1.4 User Review (Gate 2)

After architecture evaluation converges, **must** pause and ask the user to review:

```
Architecture document generated: docs/ARCHITECTURE.md

Module decomposition results:
  {number}. {module name} — {responsibility}
  ...

Please review the architecture document and confirm:
  1. Is the module decomposition reasonable? Any modules to merge or split?
  2. Do you agree with the technology stack choices?
  3. Are the dependency relationships correct?
  4. Are there any missing modules or requirements?

I will generate specification documents for each module after your confirmation.
```

Use AskUserQuestion to wait for user feedback. If user requests changes, update ARCHITECTURE.md, **re-run Phase 1.3 evaluator loop** on the revised version, then re-confirm with user.

**Critical: Do not skip user review and jump to generating module documents. Architecture decisions are the foundation for all subsequent work.**

**After user confirms architecture, update `docs/REQUIREMENTS_REGISTRY.md`:**
- Fill the `Module(s)` column for every in-scope REQ-ID (skip OUT-xxx)
- Verify 100% in-scope coverage: every Active=Y REQ-ID has at least one module
- Unmapped Active=Y REQ-ID → Critical, revise ARCHITECTURE.md before proceeding

Status update rules (merge-preserve):
- New REQ-IDs (not in existing registry): Status → Spec'd
- Existing REQ-IDs with Status == Draft: Status → Spec'd
- Existing REQ-IDs with Status in {Spec'd, Implemented, Partial, Verified}: PRESERVE current status
  (never downgrade — /spec rerun must not lose verification progress)
- Removed REQ-IDs (in registry but no longer in PRD): set Active=N, do not delete (preserves history)

---

## Phase 2: Generate Module Specification Documents

### 2.1 Generation Order

Generate in topological sort order by dependencies: generate bottom-layer modules with no dependencies first,
then generate upper-layer modules that depend on them. This way, later-generated module documents can precisely
reference interface definitions from previously generated modules.

### 2.2 Unified Module Document Template

Each module document merges PRD requirements with technical specification and implementation status.

**CRITICAL — Detail Preservation Rule:**
When absorbing PRD content into a MODULE spec, preserve ALL technical detail from the original PRD.
This includes complete code samples (TypeScript interfaces, SQL schemas, hook implementations),
full API endpoint definitions with request/response types, architecture and flow diagrams
(Mermaid/ASCII), database schema with indexes/constraints/RLS policies, environment variable
listings, and timeout/rate-limit configurations. A MODULE spec should be AT LEAST as detailed as
the PRD(s) it absorbs. If the source PRD has 1000 lines of content, the MODULE spec should be
comparable in length. Never summarize or condense technical specifications — only restructure
them into the template format.

Use Write tool to generate `docs/modules/MODULE-{number}-{module-name}.md`:

```markdown
# MODULE-{NNN}: {Module Name}

> Status: Draft | In Progress | Production
> Created: {date}
> Architecture: [ARCHITECTURE.md](../ARCHITECTURE.md)

---

## Part 1: Requirements

### 1.1 Overview

{2-3 sentences describing the module's core purpose and value}

### 1.2 Architecture Overview

{Current architecture phase description. Include architectural diagrams (Mermaid/ASCII) showing
how this module fits into the overall system. If the PRD describes phases (current vs future),
document both.}

### 1.3 Feature Matrix

| Feature | Priority | Status | Description |
|---------|----------|--------|-------------|
| {feature} | P0/P1/P2 | Implemented/Planned | {one-line description} |

### 1.4 Detailed Feature Specifications

{For EACH feature in the matrix above, create a dedicated subsection:}

#### 1.4.1 {Feature Name}

**User Flow:**
1. {Step-by-step user flow}
2. ...

**Technical Implementation:**
\```typescript
// Include actual code samples from the PRD or source code
// Show hook usage, SDK calls, key logic
\```

**Configuration:**
- {Relevant config parameters, timeouts, limits}

{Repeat 1.4.N for each feature}

### 1.5 Acceptance Criteria

AC ID format: `{MODULE-NNN}-AC-{nn}` — globally unique to support cross-module consumption.

| ID | REQ Source | Contracts | Criterion | Verification |
|----|-----------|-----------|-----------|-------------|
| MODULE-003-AC-01 | REQ-005 | CONTRACT-001 | OAuth token validation passes | unit test |
| MODULE-003-AC-02 | REQ-005 | CONTRACT-001 | Token expiry honored | integration test |
| MODULE-003-AC-03 | REQ-005 | — | UI displays login state | e2e test |
{Minimum 10 criteria for non-trivial modules}

Contracts column: comma-separated CONTRACT-IDs that this AC verifies.
Empty when AC doesn't directly verify a cross-module contract.

**Coverage requirement**: For each consumer module, every CONTRACT-ID listed in
§2.2 Required Contract MUST be referenced by at least one AC in §1.5. This ensures
no consumer-side contract dependency is silently uncovered. Module Evaluator enforces
this as Critical (cross-module regression silent gap).

### 1.6 Non-functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| ... | ... | ... |

### 1.7 Security Requirements

- {Authentication/authorization requirements}
- {Input validation rules}
- {Data protection measures}
- {Rate limiting / abuse prevention}

---

## Part 2: Specification

### 2.1 Module Boundary

**IN (Responsibilities):**
- {responsibility 1}
- {responsibility 2}

**OUT (Excluded — with owning module reference):**
- {excluded item 1, belongs to MODULE-XXX}
- {excluded item 2}

### 2.2 Dependencies

#### Upstream Dependencies (modules this module depends on)

| Module | Doc Link | Required Contract | Dependency Content | Type |
|--------|----------|------------------|-------------------|------|
| {name} | [MODULE-XXX](./MODULE-XXX-name.md) | CONTRACT-NNN | {interface/data used} | Hard/Soft |

Required Contract column references CONTRACT-{NNN} from ARCHITECTURE.md §6.1.
This is the **canonical machine-readable downstream impact source**: when a contract changes,
all modules with this column referencing it are 1st-order downstream.

#### Downstream Dependencies (modules that depend on this module)

| Module | Doc Link | Dependency Content |
|--------|----------|--------------------|
| {name} | [MODULE-XXX](./MODULE-XXX-name.md) | {interface/data provided} |

#### External Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| {library/service} | {version} | {purpose} |

#### External Dependency Evaluation

| Dependency | License | Maintenance | Known CVEs | Size Impact | Verdict |
|-----------|---------|-------------|-----------|-------------|---------|
| {library} | {MIT/Apache/...} | {Active/Maintenance/Stale} | {None/List} | {KB/MB} | {Accept/Monitor/Replace} |

Criteria: Compatible license. Last commit within 12 months. No unpatched high/critical CVEs.

### 2.3 Interface Definitions

{Include COMPLETE type definitions in code blocks. Show key public method signatures,
key exported types and interfaces relevant to this module's PRD requirements.}

#### Provided Interfaces

Every public interface must be assigned a Contract ID (registered in ARCHITECTURE.md §6.1).
The Source Files column accepts a comma-separated list (a contract's implementation may span
multiple files, and multiple contracts may share files).
This column lets the Diff Evaluator look up which contracts a diff touches (any-match
over-detection + plan allowlist filtering).

| Contract ID | Interface | Source Files | Description |
|-------------|-----------|--------------|-------------|
| CONTRACT-001 | TokenIssuer | src/auth/token.ts, src/auth/token-service.ts | OAuth token issuance |
| CONTRACT-002 | EventPublisher | src/events/types.ts | Event schema |

\```typescript
// CONTRACT-001 — TokenIssuer
interface TokenIssuer {
  issue(req: AuthRequest): Promise<Token>;
}
\```

#### Required External Interfaces

{List interfaces needed from dependency modules, with code-level references}

#### Events/Messages (if applicable)

| Event Name | Trigger | Payload | Consumer |
|-----------|---------|---------|----------|
| ... | ... | ... | ... |

### 2.4 API Endpoints

{Dedicated section for REST/WebSocket endpoints. For EACH endpoint, include full
request/response TypeScript interfaces.}

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /example | Bearer | Description |

\```typescript
// Full request DTO
interface CreateExampleDto {
  field1: string;
  field2: number;
}

// Full response type
interface CreateExampleResponse {
  id: string;
  created_at: string;
}
\```

{Repeat for each endpoint}

### 2.5 Data Models

{Include COMPLETE SQL CREATE TABLE statements, not summaries.}

\```sql
CREATE TABLE example (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- ... all columns with types, defaults, constraints
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_example_name ON example(name);

-- RLS Policies (if applicable)
CREATE POLICY "policy_name" ON example
  FOR SELECT USING (auth.uid() = user_id);
\```

#### Storage Strategy

| Data | Storage Method | Notes |
|------|---------------|-------|
| ... | ... | ... |

### 2.6 Database Functions & RPCs

| Function | Signature | Purpose | Volatility |
|----------|-----------|---------|-----------|
| {name} | {params → return} | {description} | stable/volatile |

\```sql
-- Include function bodies for non-trivial RPCs
\```

### 2.7 Core Logic

#### Business Flow

{MUST include Mermaid sequence or flow diagrams for key flows}

\```mermaid
sequenceDiagram
    participant A
    participant B
    A->>B: action
    B-->>A: result
\```

{Step-by-step description of each flow}

#### State Machine (if applicable)

\```mermaid
stateDiagram-v2
    [*] --> StateA
    StateA --> StateB: event
    StateB --> StateC: event
\```

#### Algorithms/Strategies

{Describe complex algorithms or strategies if any}

### 2.8 Error Handling

| Error Code | Error Name | Trigger Condition | Handling Strategy |
|-----------|-----------|------------------|-------------------|
| ... | ... | ... | ... |

**Error Propagation:** {How errors flow between layers}

### 2.9 Security Considerations

- {Detailed security measures specific to this module}
- {Input sanitization rules}
- {Sensitive data handling}

### 2.10 Configuration & Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| {ENV_VAR} | Yes/No | {value} | {description} |

### 2.11 Operational Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| {Timeout} | {value} | {what it controls} |
| {Rate limit} | {value} | {what it controls} |
| {Pool size} | {value} | {what it controls} |

---

## Part 3: Implementation

**Progress policy**: AC-driven. Module progress is computed from §3.4 AC Verification
(see /dev §6.1.1 for the formula). Slices (if used as a task-organization device)
contribute progress only through the ACs they make pass — no flat per-slice increments.

### 3.1 Current Status

| Status | Progress | Last Updated |
|--------|----------|--------------|
| {Not Started / In Progress / Production} | {0-100%} | {date} |

Progress = `passed/Active=Y × 100` (§3.4-driven; see /dev §6.1.1). Denominator 0 → display "—".

### 3.2 File Structure

{List key files with their roles. Use table format for clarity. For existing projects, list known files; for greenfield, list planned files.}

| File | Role |
|------|------|
| `path/to/service.ts` | {Core business logic for X} |
| `path/to/controller.ts` | {REST endpoints for Y} |
| `path/to/dto.ts` | {Request/response DTOs} |
{List key files needed for implementation: components, hooks, edge functions, migrations}

### 3.3 Test Cases

{Require test IDs, operation sequences, expected results. Minimum 10 tests for
non-trivial modules.}

Test ID format: `{MODULE-NNN}-T{nn}` — globally unique. AC Link uses global unique AC IDs.

| ID | Layer | AC Link | Scenario | Operation Sequence | Expected Result | Priority |
|----|-------|---------|----------|-------------------|-----------------|----------|
| MODULE-001-T01 | Unit | MODULE-001-AC-01 | {normal case} | {step-by-step} | {expected} | P0 |
| MODULE-001-T02 | Unit | MODULE-001-AC-01 | {boundary case} | {step-by-step} | {expected} | P1 |
| MODULE-001-T03 | Integration | MODULE-001-AC-03 | {cross-module} | {step-by-step} | {expected} | P1 |
| MODULE-001-T04 | E2E | MODULE-001-AC-01,MODULE-001-AC-02 | {user flow} | {step-by-step} | {expected} | P0 |

Layers: Unit (function/method), Integration (module interfaces, DB), E2E (user flows),
Performance (response time, throughput), Security (vulnerability, penetration).
AC Link: traceability chain is REQ-ID → {MODULE}-AC-{nn} → {MODULE}-T{nn}. Every AC must have ≥1 test.

### 3.4 Acceptance Criteria Verification

| AC ID | Active | Status | Verified By Task | Date |
|-------|--------|--------|-----------------|------|
| MODULE-001-AC-01 | Y | untested | — | — |
| MODULE-001-AC-02 | Y | untested | — | — |

Active: Y (current) / N (deprecated — excluded from all aggregation)
Status: untested → passed
(No "failed" state: DoD gates guarantee all in-scope AC are passed before SUMMARY.
A task that fails to pass an AC stays in TEST phase and never writes to this ledger.)
Verified By Task: /dev task_id that wrote this status
Date: ISO date of status change

This table is the AC-level ledger. /dev SUMMARY reads and writes it to determine
per-REQ Verified/Partial status in REQUIREMENTS_REGISTRY.md.
REQ aggregation (Registry status) only counts rows where Active == Y.

Generation rules (merge-preserve):
- First-time generation: all rows Active=Y, Status=untested
- /spec rerun (update mode): merge by AC ID —
  - Existing AC ID, Criterion UNCHANGED: PRESERVE Active + Status (do not reset)
  - Existing AC ID, Criterion CHANGED (REQ Source or Criterion text differs):
    → Set old row Active=N (deprecated, preserves history)
    → Create new row with new AC ID (MODULE-NNN-AC-{next}), Active=Y, Status=untested
    → This prevents stale verification from being inherited by changed acceptance criteria
  - New AC IDs (added in this run): Active=Y, Status=untested
  - Removed AC IDs (no longer in §1.5): Active=N (deprecated)
  - This ensures /spec rerun never loses verification progress for unchanged AC

### 3.5 Feature Implementation Record

| Feature | Status | Notes |
|---------|--------|-------|
| {feature 1} | {done/in-progress/planned} | {details} |

### 3.6 Known Gaps & Future Work

- {Gap 1: what's missing and why}
- {Future: planned enhancement}

### 3.7 Change History

| Date | Change |
|------|--------|
| {date} | Initial creation |
```

### 2.3 Batch Generation Strategy

- Generate module documents one by one in topological sort order
- After each module document is generated, briefly report progress:
  ```
  [Module Doc Progress] {completed}/{total} — Generated MODULE-{number}-{name}
  ```
- If module count exceeds 5, independent modules (no mutual dependencies) MAY be generated in parallel
  (max 3 concurrent). Each parallel module still runs its own evaluator loop (2.4) before being marked complete.
  Modules that depend on each other MUST be generated sequentially (topological order).

### 2.4 Module Evaluator Loop (per module, Independent Evaluator Architecture)

After each MODULE document is generated, run an evaluator loop before proceeding to the next module.

**Immutable spec**: PRD.md + ARCHITECTURE.md. **Mutable output**: MODULE-xxx.md. **Convergence**: PRD detail coverage == 100% AND substantive_count == 0.

```
For each module (in topological order):
  Generate MODULE-{NNN}-{name}.md
  eval_round = 0

  repeat:
    eval_round += 1

    ──────────────────────────────────────────────────────────────
    STEP 1: Spawn TWO fresh Module Evaluators in parallel
    (Per Dual-Evaluator Sync Protocol rule 1: Claude Agent call + Codex Bash
     MUST be fired in the SAME assistant response, not sequentially.)
    ──────────────────────────────────────────────────────────────

    ① Claude Module Evaluator (Agent, subagent_type: claude-auditor)
       prompt:
         "You are an independent module spec evaluator. Round {eval_round}.
          You have ZERO knowledge of how this spec was generated.

          PRD file(s): {prd_paths}
          Architecture doc: docs/ARCHITECTURE.md
          Module spec: docs/modules/MODULE-{NNN}-{name}.md

          Check:
          1. PRD detail preservation — every code sample, SQL schema, API def,
             diagram, config value from PRD relating to this module must appear.
          2. Interface consistency — module interfaces match ARCHITECTURE.md.
          3. Template completeness — all sections have substantive content.
          4. Cross-module references — dependencies exist, required interfaces match.
          5. Requirement traceability (Active determined by §3.4 ledger):
             if REQUIREMENTS_REGISTRY.md exists, verify Active=Y REQ-ID → Active=Y AC (per §3.4) → Test ID
             chain is complete for this module.
             Missing AC for Active=Y REQ-ID → Critical. Test without AC Link → Warning.
             §1.5/§3.3 referencing Active=N IDs → Warning (stale reference).
          6. Contract reference consistency (if ARCHITECTURE.md §6.1 has Contract Registry):
             - §2.3 Provided Interfaces Contract IDs must be registered in §6.1 as Active=Y
             - §2.2 Required Contract IDs must exist in some module's §2.3 Provided
             - §1.5 Contracts column IDs must be in this module's §2.2 Required (consumer AC)
               or this module's §2.3 Provided (producer AC)
             - Reference to non-existent contract → Critical
             - Reference to Active=N contract → Warning (stale)
             - **Coverage enforcement**: every CONTRACT-ID in §2.2 Required Contract MUST be
               referenced by at least one AC in §1.5 → Critical if uncovered
             - Source Files column allows multi-to-multi (file shared, contract spans multiple files)

          Output format (MANDATORY):
          Module Evaluation: Round {eval_round} — {module_name}
          PRD Detail Coverage: {covered}/{total} items
          Missing Details:
          1. [Critical] PRD §{section} ... — not included
          Interface Mismatches:
          1. [Critical/Warning] ARCHITECTURE says X, MODULE says Y
          Template Completeness: {filled}/{total} sections
          Empty Sections:
          1. [Warning] §{section} — placeholder only
          Traceability Issues:
          1. [Critical/Warning] {description} — REQ-xxx has no AC / AC has no test / etc.
          Contract Issues:
          1. [Critical/Warning] {description} — invalid contract reference / uncovered Required Contract / etc.
          Substantive Findings: {Critical + Warning count}
          Verdict: PASS | FAIL"

    ② Codex Module Evaluator (Bash, codex exec, timeout: 600000)
       prompt: "[PLAN MODE — DEEP REVIEW] Before reviewing, create a review plan. Phase 1: identify all review dimensions. Phase 2: execute systematically. Phase 3: synthesize findings with severity levels and verdict." +
         "Independent module spec evaluator. Round {eval_round}.
          Read PRD: {prd_paths}. Read ARCHITECTURE: docs/ARCHITECTURE.md.
          Read MODULE: docs/modules/MODULE-{NNN}-{name}.md.
          Check: PRD detail preservation (code samples, schemas, API defs),
          interface consistency with ARCHITECTURE, template completeness.
          Also check requirement traceability (Active determined by §3.4 ledger):
          if REQUIREMENTS_REGISTRY.md exists, verify Active=Y REQ-ID → Active=Y AC-ID (per §3.4) → Test ID
          chain is complete for this module.
          Missing AC for Active=Y REQ-ID → Critical. Test without AC Link → Warning.
          §1.5/§3.3 referencing Active=N IDs → Warning (stale reference).

          Also check contract reference consistency (if ARCHITECTURE.md §6.1 has Contract Registry):
          - §2.3 Provided Contract IDs registered in §6.1 as Active=Y
          - §2.2 Required Contract IDs exist in some module's §2.3 Provided
          - §1.5 Contracts column refs valid (consumer-side: in §2.2; producer-side: in §2.3)
          - Reference to non-existent contract → Critical
          - Reference to Active=N contract → Warning
          - Coverage: every §2.2 Required Contract MUST be referenced by ≥1 AC in §1.5 → Critical if uncovered

          YOUR FINAL OUTPUT MUST USE THIS EXACT FORMAT (mandatory):
          Module Evaluation: Round {eval_round} — {module_name}
          PRD Detail Coverage: {covered}/{total} items
          Missing Details:
          1. [Critical] PRD §{section} ... — not included
          Interface Mismatches:
          1. [Critical/Warning] ARCHITECTURE says X, MODULE says Y
          Template Completeness: {filled}/{total} sections
          Empty Sections:
          1. [Warning] §{section} — placeholder only
          Traceability Issues:
          1. [Critical/Warning] {description}
          Contract Issues:
          1. [Critical/Warning] {description}
          Substantive Findings: {Critical + Warning count}
          Verdict: PASS | FAIL

          Use ONLY Critical/Warning/Info severity levels. Do NOT use High/Medium/Low."
       Command:
       ```
       codex exec "<prompt above>" \
         -C "$(git rev-parse --show-toplevel)" \
         -s read-only \
         -c 'model_reasoning_effort="high"' \
         --json 2>/dev/null | jq -r --unbuffered '
           if .type == "item.completed" and .item then
             if .item.type == "agent_message" and .item.text then .item.text
             else empty end
           elif .type == "turn.completed" and .usage then
             "tokens: " + ((.usage.input_tokens // 0) + (.usage.output_tokens // 0) | tostring)
           else empty end
         '
       ```
       Bash timeout: 600000.

    Fallback: codex not available → Claude only.

    **IMPORTANT: Wait for BOTH evaluators to complete before proceeding.**
    The Codex Bash command runs in the **foreground** (`timeout: 600000`, blocking;
    **do NOT** set `run_in_background: true`). The Bash tool does not return until
    `codex exec` exits, so stdout is safe to read immediately on return. See the
    "Known bug workaround" note near the Codex command template for context.
    Do NOT proceed to STEP 2 until both evaluator outputs are fully available.

    ──────────────────────────────────────────────────────────────
    STEP 2: Merge & Verdict
    ──────────────────────────────────────────────────────────────
    **Barrier assertion (Sync Protocol rule 2)**: before entering STEP 2, all of
    the following must hold:
      - claude_result is returned AND format is valid
      - codex_result is returned AND format is valid, OR codex_available == false
    If either fails → apply Sync Protocol rule 3 (retry Codex once in same round,
    Claude's cached result is reused — do NOT re-run Claude).
    Two consecutive rounds of Codex failure → force degraded mode:
      - codex_available = false
      - degraded_from_round = eval_round
      - all subsequent rounds skip Codex, mark as single-evaluator

    **STEP 2.5: Per-evaluator counter update + invariant (Sync Protocol rule 4)**
    After merge completes, update progress.json counters for this module:
      modules_in_progress["MODULE-NNN-name"].claude_rounds_run += 1  (always)
      if codex participated this round and output was valid:
        modules_in_progress["MODULE-NNN-name"].codex_rounds_run += 1
    Assert invariants before writing step 3 results:
      claude_rounds_run == eval_round
      codex_rounds_run == eval_round OR
        (codex_available == false AND codex_rounds_run == degraded_from_round - 1)
    Invariant violation → stop the loop and AskUserQuestion to report process failure.


    Merge rules:
    - Merge Missing Details, Interface Mismatches, Empty Sections (deduplicate)
    - Merge Traceability Issues (deduplicate)
    - Merge Contract Issues (deduplicate)
    - Both found same issue → high confidence

    If PRD detail coverage == 100% AND substantive_count == 0 → converged, proceed to next module

    If findings exist:
    - Main agent revises MODULE doc based on evaluator report
    - Back to STEP 1 (fresh evaluators)

    > 10 rounds per module → AskUserQuestion
  
  Report progress: [Module Eval] {completed}/{total} — MODULE-{NNN}-{name} {converged in {rounds} rounds | accepted at round {rounds}}
```

### 2.5 Cross-reference Check

After all module documents are generated and individually evaluated, perform final cross-reference integrity check:
- Every dependency module referenced in each module document exists
- Interface definitions are consistent between provider and consumer
- All module responsibilities combined cover the complete PRD

---

## Phase 3: Generate Implementation Order

### 3.1 Topological Sort

Based on dependency graph, calculate implementation order. Principles:
- Foundation modules with no dependencies come first
- Same-layer modules can be implemented in parallel
- Each phase ends with an integration-testable milestone

### 3.2 Implementation Order Document

Use Write tool to generate `docs/IMPLEMENTATION_ORDER.md`:

```markdown
# Implementation Order

> Project: {project name}
> Generated: {date}
> Total Modules: {N}

---

## Dependency Graph

\```mermaid
graph LR
    M001[MODULE-001: Module A] --> M003[MODULE-003: Module C]
    M002[MODULE-002: Module B] --> M003
    M003 --> M005[MODULE-005: Module E]
    M004[MODULE-004: Module D] --> M005
\```

## Implementation Phases

### Phase 1: Foundation Layer (No External Dependencies)

| Order | Module Doc | Module | Estimated Effort | Parallelizable |
|-------|-----------|--------|-----------------|----------------|
| 1.1 | [MODULE-001](modules/MODULE-001-xxx.md) | {name} | {time} | Yes |
| 1.2 | [MODULE-002](modules/MODULE-002-xxx.md) | {name} | {time} | Yes |

**Phase Milestone:** {verifiable integration goal}

### Phase 2: Core Layer

| Order | Module Doc | Module | Prerequisites | Estimated Effort | Parallelizable |
|-------|-----------|--------|--------------|-----------------|----------------|
| 2.1 | [MODULE-003](modules/MODULE-003-xxx.md) | {name} | MODULE-001, MODULE-002 | {time} | No |

**Phase Milestone:** {verifiable integration goal}

{Continue adding more phases...}

## Critical Path

{Identify the critical path affecting total duration}

\```mermaid
gantt
    title Implementation Gantt Chart
    dateFormat  YYYY-MM-DD
    section Phase 1
    Module A :a1, 2024-01-01, 3d
    Module B :a2, 2024-01-01, 2d
    section Phase 2
    Module C :a3, after a1 a2, 4d
\```

## AI Agent Implementation Guide

When handing a module to an AI Agent for implementation, provide:
1. The module's specification document
2. All upstream dependency module spec documents (interface sections only)
3. Relevant sections from ARCHITECTURE.md
4. Already-implemented upstream module code (if available)

### Agent Prompt Template

\```
Please implement MODULE-{number} ({module name}) based on the following documents:

1. Module spec: docs/modules/MODULE-{number}-{name}.md
2. Architecture doc: docs/ARCHITECTURE.md
3. Dependency module interfaces: {list dependency module interface sections}

Implementation requirements:
- Strictly follow the interface definitions in the module spec
- Include all test cases defined in the spec
- Follow the directory structure suggestions in the spec
- Meet all acceptance criteria
\```
```

---

## Phase 4: Final Report

**Strict template — whitelist only (fixes #27 and #30)**: the Final Report MUST be
rendered strictly with the fields below. Adding **any** field that is not in the
template (for example "Known gaps" / "TODO" / "Deferred items" / "not yet aligned" /
"needs follow-up" and similar free-form fields) is **forbidden**. If a remaining
problem from a non-converged evaluator must be recorded, the only legitimate path
is `accepted at round N` (the user has explicitly accept-at-limit'd it), and it
must be traceable in progress.json.

After all documents are generated, present a summary to the user:

```
Spec Document Generation Complete

Document List:
  docs/ARCHITECTURE.md            — Architecture Design Document
  docs/IMPLEMENTATION_ORDER.md    — Implementation Order
  docs/modules/
    MODULE-001-{name}.md          — {responsibility}
    MODULE-002-{name}.md          — {responsibility}
    ...(total N module documents)

Module Decomposition: {N} modules
Implementation Phases: {M} phases
Critical Path: {critical path description}

Evaluator Results:
  Architecture: {converged in {N} rounds | accepted at round {N}} (PRD coverage: {X}% → {final}%)
  Module evaluations:
    MODULE-001-{name}: {converged in {N} rounds | accepted at round {N}}
    MODULE-002-{name}: {converged in {N} rounds | accepted at round {N}}
    ...

Next Steps:
  1. Review each module document, confirm interface definitions and acceptance criteria
  2. Begin implementation following IMPLEMENTATION_ORDER.md sequence
  3. Run corresponding integration tests after completing each module
```

**Template field whitelist** (any field not in this list is forbidden in output):
Document List / Module Decomposition / Implementation Phases / Critical Path /
Evaluator Results / Next Steps

**Forbidden field examples** (their presence counts as a process violation):
~~Known Gaps~~ / ~~TODO~~ / ~~Deferred~~ / ~~Known Issues~~ /
~~Pending refinement~~ / ~~Needs follow-up~~ /
~~Out of Scope~~ (OUT-xxx formal scope exclusions are the only allowed form)

---

## Error Handling

### Incomplete PRD
- If PRD lacks critical information (e.g., technical constraints, non-functional requirements), use AskUserQuestion to ask the user for supplementary info
- Note in ARCHITECTURE.md "Key Decision Records" which decisions are based on assumptions

### Abnormal Module Count
- More than 15 modules: Consider granularity too fine, propose merging related modules
- Fewer than 3 modules: Consider granularity too coarse, propose further decomposition
- Use AskUserQuestion to discuss with user

### Circular Dependencies
- If circular dependencies detected, must redesign module boundaries
- Common solutions: introduce interface layer / event-driven decoupling / merge modules

### Update Mode
- If user chooses "Update changed parts only":
  1. Read existing ARCHITECTURE.md and all module documents
  2. Compare PRD changes
  3. Update only affected documents
  4. **Run evaluator loops on updated documents** (Architecture Evaluator if ARCHITECTURE.md changed, Module Evaluator for each updated MODULE)
  5. Record modification history in documents
