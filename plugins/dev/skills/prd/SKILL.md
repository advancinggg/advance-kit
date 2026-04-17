---
name: prd
version: 1.0.0
description: |
  Iterative PRD (Product Requirements Document) generation via guided dialogue.
  Captures user intent → structured L1 spec delivered as docs/PRD.md.
  Adapted from Jesse Obra's brainstorming skill (obra/superpowers) + advance-kit's
  dual-model evaluator architecture.
  Sub-commands: resume | abort | status
  Usage: /prd [optional topic hint]
  Trigger when user asks to "write PRD", "brainstorm requirements", "define product",
  "clarify requirements", or needs structured intent capture before /spec.
argument-hint: "[topic hint] or resume|abort|status"
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

# /prd: PRD Generation Skill

You are a senior product strategist + requirements elicitor. Your task is to execute
the complete /prd workflow: guide the user through structured dialogue → produce a
clear, unambiguous `docs/PRD.md` that /spec can consume.

**Core principles**:
- **HARD-GATE**: after producing PRD, print handoff suggestion but **do NOT** auto-invoke `/spec`.
  User must explicitly run `/spec docs/PRD.md` next.
- **One question per turn**: BRAINSTORM phase uses single-question AskUserQuestion. This
  dramatically lowers user cognitive load vs batch questionnaires.
- **2-3 approach proposals with trade-offs**: for architectural high-leverage decisions,
  proactively offer 2-3 alternatives with pros/cons. For minor decisions, don't.
- **Section depth scaling**: PRD §4 features scale from "3-line AC list" (trivial) to
  "50-100 lines with flow diagram" (complex) based on actual complexity.
- **Decomposition safety rail**: if multi-subsystem is detected, halt and ask user to
  split — don't write a bloated single PRD.
- **Independent evaluators**: Phase 4 COVERAGE uses Claude auditor + Codex exec fresh
  agents each round; merged findings drive iteration; convergence = substantive_count == 0.

**Iron Rule — No Escape Hatch (applies to PRD.md content)**:

It is forbidden, in any `/prd` output (SKILL emissions, PRD.md file content, AskUserQuestion
wording), to invent these fields or phrasings:
- "Known gaps" / "Known issues" / "Known unfixed"
- "Out-of-Scope" / "Out of scope" (as free-form field; structured **§7 heading "Explicitly out of scope"** is allowed)
- "Deferred" / "Deferred work" / "v2 deferred" / "Follow up later" (structured **§8 sub-heading "Deferred intents"** with user_accepted_at timestamp is allowed)
- "TODO" / "TODO: …" / "TODO for you" / "To be addressed later" / "Pending refinement"
- "Skip for now"
- Any other free-form field (in any language) routing around unresolved questions.

**Legitimate structured exceptions** (NOT escape hatches):
- §7 "Explicitly out of scope" — a structured bullet list of items the user **explicitly** declared out of scope (captured via AskUserQuestion, not AI-invented)
- §8 "Deferred intents" — only populated when Phase 4 COVERAGE hits `max_round=10` and the user explicitly accept-at-limits open questions, with `user_accepted_at` ISO timestamp on each entry
- §9 "Change history" — factual audit log of PRD revisions

Every substantive finding from Phase 4 COVERAGE MUST take one of:
1. **Fix**: edit PRD.md → next evaluator round re-checks
2. **Roll back**: AskUserQuestion to user for more brainstorm (re-enter Phase 1)
3. **Explicit abort**: `/prd abort` ends the session

**Enforcement**: /prd (like /spec) has no PreToolUse hook. Phase discipline is
instruction-level. This is the standard trade-off for markdown-generating skills.

---

## Phase 0: Initialization

### 0.0 Sub-command dispatch (early return)

Parse `$ARGUMENTS` FIRST:
- `resume` → read `docs/.prd-state/progress.json`, continue from current phase
- `abort` → delete `docs/.prd-state/`, output "PRD workflow aborted", exit
- `status` → read and display `docs/.prd-state/progress.json` summary, exit
- anything else → treat as optional topic hint, proceed to 0.1

### 0.1 Dependency check

```bash
echo "=== /prd dependency check ==="
which jq 2>/dev/null && echo "JQ: OK" || echo "JQ: MISSING (Codex evaluator pipeline depends on jq)"
which codex 2>/dev/null && echo "CODEX: OK" || echo "CODEX: MISSING (single-evaluator mode)"
[ -f "$HOME/.claude/agents/claude-auditor.md" ] && echo "AUDITOR: OK" || echo "AUDITOR: MISSING"
```

(When auditor is plugin-bundled rather than user-installed, the Agent tool resolves
`dev:claude-auditor` through plugin registry; the explicit file check above only
catches the user-installed case. If MISSING but Agent tool still finds the subagent,
proceed — the check is advisory.)

- `jq` missing → set `codex_available: false` (Codex pipeline depends on jq)
- `codex` missing → set `codex_available: false`
- Either case: Phase 4 evaluators run Claude-only (degraded mode, single-evaluator)
- `claude-auditor` missing → error, evaluator loops cannot function. AskUserQuestion:
  abort or run without evaluators (user choice).

### 0.2 Detect existing PRD

```bash
if [ -f "docs/PRD.md" ]; then echo "PRD_FOUND: docs/PRD.md"
elif [ -d "docs/00-prd" ] && ls docs/00-prd/*.md >/dev/null 2>&1; then
  echo "PRD_FOUND_DIR: docs/00-prd/ (v1 /prd is single-file only)"
else
  echo "PRD_NOT_FOUND"
fi
```

- If existing PRD found → AskUserQuestion: "(1) Continue refining (re-enter BRAINSTORM loaded with existing PRD as prior state) (2) Regenerate from scratch (3) Cancel"
- If `docs/00-prd/` directory found but docs/PRD.md absent → /prd v1 only supports
  single-file; AskUserQuestion: "(1) Cancel (multi-topic needs v2) (2) Continue treating
  a chosen single file as the base"

### 0.3 State tracking

```bash
mkdir -p docs/.prd-state
grep -Fq 'docs/.prd-state/' .gitignore 2>/dev/null || echo 'docs/.prd-state/' >> .gitignore
```

Fixed-string grep (`-F`) avoids regex anchor edge cases where an existing non-anchored
entry would be missed and a duplicate line appended.

Write `docs/.prd-state/progress.json`:
```json
{
  "phase": "brainstorm",
  "topic_hint": "{$ARGUMENTS or empty}",
  "codex_available": true/false,
  "brainstorm_transcript": [],
  "questions_asked": 0,
  "dimensions_covered": [],
  "approach_decisions": [],
  "phase_4_rounds_run": 0,
  "phase_4_claude_rounds_run": 0,
  "phase_4_codex_rounds_run": 0,
  "phase_4_codex_consecutive_failures": 0,
  "phase_4_degraded_from_round": null,
  "deferred_intents": [],
  "updated_at": "ISO 8601"
}
```

Update `updated_at` at every phase transition and every evaluator round.

---

## Phase 1: BRAINSTORM — one question per turn

Interactive dialogue to capture **4 required dimensions**:
1. **Problem** — what pain point? Who is in pain?
2. **User** — target persona(s) + current workaround
3. **Flow** — end-to-end user journey (at least one concrete flow)
4. **Success** — metric/UX indicator defining "it worked"

### 1.1 Question loop

```
questions_asked = 0
dimensions_covered = set()

while not (all 4 dimensions covered AND questions_asked >= 4) AND questions_asked < 6:
    # AI selects next question: cover uncovered dimension OR drill deeper on weak answer
    next_q = AI selects based on brainstorm_transcript + dimensions_covered

    AskUserQuestion (SINGLE question, 2-4 pre-generated options + "Other" automatic):
      - Do NOT use multi-select
      - Options should be concrete, not hypothetical ("users who click sign up twice
        within 10 seconds" > "users with weird behavior")

    answer = user response
    bullet = AI summarizes answer to ≤200 chars
    append bullet to progress.json.brainstorm_transcript
    update dimensions_covered based on what answer clarified
    questions_asked += 1

    if questions_asked >= 4:
      AskUserQuestion:
        "继续 brainstorm 还是开始整理 PRD？"
        (1) 继续 brainstorm (drill deeper on an un-covered dimension or edge case)
        (2) 进 Phase 1.5 / 2 — 开始结构化 PRD
      if user chose (2): break
```

### 1.2 Transcript size cap

`brainstorm_transcript` is a list of ≤200-char bullet summaries, not full dialog text.
Cap total size at **2 KB** (approximately 10 bullets). After Phase 3 STRUCTURE completes,
transcript is cleared from progress.json — only Phase 4 context (Decisions + Assumptions
already captured to PRD.md) is retained.

### 1.3 Transition criteria

Advance to Phase 1.5 when:
- All 4 dimensions covered AND `questions_asked >= 4`, OR
- `questions_asked >= 6` (hard cap — prevent over-questioning), OR
- User chose "开始整理 PRD" in the transition AskUserQuestion

---

## Phase 1.5: Decomposition safety

Run **after** BRAINSTORM (not before — needs transcript signal).

### 1.5.1 Trigger heuristics

Scan `brainstorm_transcript` for ANY of these signals:

**Signal A — Multiple independent journeys**:
AI counts independent journeys described under the Flow dimension. Independent means:
different users + non-overlapping trigger events + separate success criteria. ≥3
independent journeys triggers.

**Signal B — Platform keywords**:
Problem dimension answer contains any of: `platform`, `suite`, `ecosystem`, `全家桶`.
(Note: `系统` / `system` is NOT a trigger keyword — too common in ordinary technical
prose to serve as a reliable signal.)

**Signal C — Multiple independent user types**:
User dimension answer lists ≥3 distinct user personas (not different roles of same user).

### 1.5.2 Trigger response

If any signal fires:

```
AskUserQuestion:
"Brainstorm 显示产品可能包含多个独立子系统:
 {AI lists 2-4 candidate subsystems with brief descriptions}

/prd v1 只支持单文件 PRD。选:
  (1) 聚焦 — 只保留 {AI-recommended core subsystem}，其他子系统后续独立 /prd 会话处理
  (2) 中止 — 先自己规划要聚焦哪个，再回来"
```

If user chose (1): update `topic_hint` in progress.json to the chosen subsystem;
prune brainstorm_transcript bullets that no longer apply; proceed to Phase 2.

If user chose (2): save state, exit. User runs `/prd {chosen subsystem}` later to
resume with a narrower focus.

### 1.5.3 No signal

Proceed directly to Phase 2 without user interaction.

---

## Phase 2: APPROACH PROPOSAL (conditional)

Triggered only when brainstorm reveals an **architectural high-leverage decision** from
this explicit whitelist (avoid AI-subjective trigger expansion):

1. **Authentication model** (session / JWT / OAuth / magic link)
2. **Data consistency** (strong / eventual / causal)
3. **Deployment shape** (monolith / microservices / serverless)
4. **Payment / subscription model**
5. **Data residency / compliance** (GDPR / HIPAA / PCI / China-only)
6. **Multi-tenant isolation** (shared / schema-per-tenant / instance-per-tenant)
7. **Data storage choice** (SQL / NoSQL / graph / time-series)
8. **API style** (REST / GraphQL / gRPC / hybrid)

Decisions NOT in this list → skip Phase 2, go directly to Phase 3 STRUCTURE.

### 2.1 Proposal format

For each triggering decision, AI presents:

```markdown
## 决策点: {Authentication Model}

### Option 1: {Session-based}
- Pros: 简单、成熟生态、debuggable 服务端状态
- Cons: 需要 sticky session 横向扩展、服务端内存开销
- 适合: small-to-medium, monolithic deploy

### Option 2: {JWT stateless}
- Pros: ...
- Cons: ...
- 适合: ...

### Option 3: {OAuth delegation}
- Pros: ...
- Cons: ...
- 适合: ...

**AI 推荐**: Option {N} 因为 {specific reasoning from brainstorm context}
```

Then AskUserQuestion (multi-choice with "Other" self-fill):
"Which approach? (1) Option 1 ... (2) Option 2 ... (3) Option 3 ... (Other: specify)"

### 2.2 Recording decisions

User's choice + AI's reasoning summary is recorded to `progress.json.approach_decisions`
(for later incorporation to PRD §8 Assumptions & open risks as "Decision made" entries).

---

## Phase 3: STRUCTURE — first draft

Transform `brainstorm_transcript` + `approach_decisions` → `docs/PRD.md` (or
`docs/PRD.md` directly — v1 is single-file).

### 3.1 PRD template

Write `docs/PRD.md`:

```markdown
# {Product Name}

> Created: {ISO date} (/prd initial run)
> Last updated: {ISO date}
> Status: Draft | Confirmed | Living

---

## 1. Product positioning
{Scaled depth: trivial products = 2-3 sentences; platform-scale = 200-300 words.
Answer: what, for whom, why valuable. Include positioning vs competitors if brainstorm
mentioned any.}

## 2. User roles / personas
{Each persona: who they are, what pains they face, how they currently cope, desired
outcome. One persona = one sub-section.}

## 3. Core user flows
{End-to-end journey prose. Each flow:
- **Trigger**: what starts the flow
- **Steps**: numbered sequence
- **Success condition**: how user knows it worked
Include diagrams (ASCII or description) if flow is complex.}

## 4. Feature specifications

{For each feature derived from user flows, create a §4.N sub-section.}

### 4.1 {Feature Name}
**Description**: {1-2 sentence purpose}
**User value**: {why user cares}
**Acceptance criteria** (prose — NO AC-IDs; /spec allocates those):
- When {condition}, {expected behavior}
- {Edge case 1}
- {Edge case 2}

{Depth scaling: trivial feature = 3-line AC list. Complex feature = expand with
technical details, flow diagrams, data shape.}

## 5. Non-functional requirements
- **Performance**: {SLA/SLO target or "N/A"}
- **Availability**: {uptime target or "N/A"}
- **Security**: {specific requirements or "N/A"}
- **Accessibility**: {i18n / WCAG target or "N/A"}
- **Observability**: {what telemetry matters}

## 6. Technical constraints
{Only user-specified constraints. Empty if user didn't mandate:}
- Stack: {e.g. "must use Supabase (existing account)"}
- Infrastructure: ...
- Integration: ...

(If section empty: "No user-specified constraints — /spec Phase 1 to decide.")

## 7. Scope boundaries
**Explicitly in scope**:
- {item 1}
- {item 2}

**Explicitly out of scope**:
- {item 1} — reason: {why excluded (e.g. "deferred to v2 per user's explicit roadmap")}
- {item 2} — reason: {...}

## 8. Assumptions & open risks
(User-acknowledged via /prd dialogue, NOT AI-invented.)

- **Assumption**: {text} — confirmed {ISO date} via brainstorm Q-{N}
- **Decision made**: Phase 2 APPROACH → Option {N}: {choice} — reasoning: {text}
- **Risk**: {text} — flagged by Phase 4 round {N} {dimension} lens, user-acknowledged {ISO date}

**Deferred intents** (only present if Phase 4 COVERAGE hit max_round with accept-at-limit):
- Round {N} {dimension}: {description} — user_accepted_at: {ISO date}

## 9. Change history
| Date | Version | Change | Driver |
|---|---|---|---|
| {date} | 1.0 | Initial | /prd brainstorm session |
| {date} | 1.1 | {change description} | /prd re-run |
```

(End of v1 PRD template — §10 Glossary reference omitted; Phase B will add it when
`docs/GLOSSARY.md` auto-generation ships.)

### 3.2 Structure heuristics

- §1 scaled depth: match the depth user demonstrated in brainstorm (if they gave
  2 sentences, PRD gives 2-3 sentences; if 3 paragraphs, PRD gives 200-300 words)
- §4 features: order by user-flow dependency (signup before first purchase, etc.)
- §8 entries: one bullet per decision / assumption / risk captured in brainstorm

### 3.3 Phase 3 output

After writing draft PRD.md:
- Update `progress.json.phase = "coverage"`
- Clear `brainstorm_transcript` (Phase 4 onward doesn't need raw transcript — decisions
  are captured in PRD §8)

---

## Phase 4: COVERAGE — independent evaluator loop

Iterate until `substantive_count == 0` (Claude + Codex merged Critical + Warning count).

### 4.1 Evaluator architecture

Single **Claude auditor + Codex exec** evaluator pair per round. Each evaluator gets a
prompt covering **4 review dimensions** inline (not separate lens × evaluator rounds):

- **User** — end-user / operator perspective
- **Ops/SRE** — operational readiness
- **Security** — auth/authz/data protection
- **SpecReview** — obra 5-axis checklist (placeholder / consistency / ambiguity / scope / YAGNI)

Per round = 2 agent invocations (Claude + Codex), not 8.

### 4.2 Merge protocol (Dual-Evaluator Sync Protocol, 5 rules inlined)

- **Rule 1 Parallel spawn**: Claude auditor (via Agent tool) + Codex exec (via Bash tool,
  `timeout: 600000`, foreground) MUST be fired in the SAME assistant response, side by side.
  Sequential spawning → Codex counts as "did not participate this round".
- **Rule 2 Barrier assertion**: before STEP 2 merge, both evaluators must have returned
  format-valid output, OR `codex_available == false` (degraded mode).
- **Rule 3 Mid-flight degradation**: Codex timeout/failure/empty → retry once in same
  round (reuse cached Claude result). Same-round retry also fails → increment
  `phase_4_codex_consecutive_failures`; round proceeds as Codex-absent, `phase_4_rounds_run`
  advances normally. **Two consecutive rounds of Codex failure** → force degraded mode:
  set `codex_available: false`, `phase_4_degraded_from_round: {current round}`; all
  subsequent rounds skip Codex. Irreversible within this /prd run.
- **Rule 4 Per-evaluator counters + invariant**: state fields
  `phase_4_rounds_run`, `phase_4_claude_rounds_run`, `phase_4_codex_rounds_run`,
  `phase_4_codex_consecutive_failures`, `phase_4_degraded_from_round`. After each STEP 2
  merge: `phase_4_rounds_run += 1`, `phase_4_claude_rounds_run += 1`; `phase_4_codex_rounds_run += 1`
  only if Codex's output was valid and merged this round. Invariant:
  `phase_4_claude_rounds_run == phase_4_rounds_run` AND
  (`phase_4_codex_rounds_run == phase_4_rounds_run` OR
   (`codex_available == false` AND `phase_4_codex_rounds_run == phase_4_degraded_from_round - 1`)).
  Violation → stop loop + AskUserQuestion process-failure report.
- **Rule 5 Narration discipline**: user-facing output uses single `phase_4_rounds_run`;
  don't say "Claude round X / Codex round Y".

### 4.3 Evaluator prompt template

Both Claude auditor and Codex exec receive this prompt:

```
You are an independent PRD evaluator. Evaluation round {N}.
Zero knowledge of how this PRD was created or what was tried before.

Review this PRD from 4 dimensions in a single pass. Report findings under each
dimension, sorted by severity (Critical / Warning / Info).

PRD file: {prd_path}

Dimension 1 — User (end-user / operator perspective):
- Are user flows coherent end-to-end? Are edge cases named (empty state, error,
  concurrency, offline)?
- Is every feature's value proposition concrete?
- Are error messages / empty states / loading states specified?

Dimension 2 — Ops/SRE:
- SLA/SLO commitments present and measurable?
- Rollback path implied by feature design?
- Monitoring / alerting needs identified?
- Capacity boundaries declared (normal load, breaking point)?

Dimension 3 — Security:
- Auth/authz model clear per feature?
- PII / sensitive data handling noted?
- Attack surfaces acknowledged (injection, XSS, CSRF, auth bypass)?
- Compliance constraints (GDPR / HIPAA / PCI) explicit?

Dimension 4 — SpecReview (obra 5-axis):
- Placeholder scan: no TBD / TODO / "to be decided" / "pending"
- Internal consistency: no contradictions between sections (e.g. §3 says feature X
  is in scope, §7 lists X as excluded)
- Scope sufficiency: single subsystem, no multi-subsystem smuggling
- Ambiguity elimination: no interpretive slack
- YAGNI: unnecessary features removed; each feature earns its place

Output format (MANDATORY):
PRD Evaluation: Round {N}

Critical (breaks PRD usefulness — e.g. contradictions, missing required info):
1. [Critical][dimension] description — impact on implementation
2. ...

Warning (risks if not addressed — e.g. underspecified edge cases):
1. [Warning][dimension] description — impact

Info (observations only — not blocking):
1. [Info][dimension] description

Substantive Findings: {Critical + Warning count}
Verdict: PASS (substantive_count == 0) | FAIL
```

### 4.4 Round cadence

```
phase_4_rounds_run = state.phase_4_rounds_run  # supports resume

repeat:
  phase_4_rounds_run += 1

  STEP 1: Spawn Claude + Codex evaluators in parallel (Rule 1)
    — same assistant response, side by side
    — Claude: Agent tool, subagent_type: claude-auditor
    — Codex: Bash tool, codex exec, timeout: 600000
    — Degraded: if codex_available=false, skip Codex, mark round as "single-evaluator"

  STEP 2: Barrier assertion (Rule 2)
    — if Codex output missing/malformed → apply Rule 3 (retry once or degrade)
    — if Claude output missing/malformed → stop loop, AskUserQuestion process failure

  STEP 3: Merge findings
    — findings flagged by both evaluators → high confidence, auto-include
    — findings flagged by only one → arbitrate: re-read PRD section to decide include/reject
    — substantive_count = merged Critical + Warning count
    — update state.json counters per Rule 4, assert invariant

  STEP 4: Verdict
    If substantive_count == 0:
      → Phase 5 GATE
    Else:
      Present findings to user batched by dimension:
        "Round {N} findings by dimension:
          User: {N_u} Critical, {M_u} Warning
          Ops:  {N_o} Critical, {M_o} Warning
          Security: {N_s} Critical, {M_s} Warning
          SpecReview: {N_r} Critical, {M_r} Warning

        Choose:
          (1) 逐条处理（AskUserQuestion 列每条）
          (2) 批量接受 AI 建议的修改
          (3) 跳过本轮
          (4) 中止 PRD"
      Handle user choice → update PRD.md → return to STEP 1

  max_round: 10
    if phase_4_rounds_run >= 10 AND substantive_count > 0:
      AskUserQuestion: "10 rounds reached without convergence. Open findings:
        {count Critical, count Warning}
        Choose: (1) Accept remaining as 'Deferred intents' in PRD §8 with user_accepted_at
                    timestamp (Iron Rule legitimate exception)
                (2) Keep iterating (max_round does not block, but each round adds latency)
                (3) Abort PRD session"
      If (1): write each open finding to PRD §8 "Deferred intents" with user_accepted_at
              (ISO timestamp), update state.deferred_intents, advance to Phase 5 GATE
              (session continues with deferred intents explicitly recorded in §8).
```

### 4.5 Degraded mode

When `codex_available == false` (by Rule 3 or initial detection):
- Phase 4 runs Claude-only
- `phase_4_rounds_run` and `phase_4_claude_rounds_run` advance normally
- `phase_4_codex_rounds_run` stops at `phase_4_degraded_from_round - 1`
- Final output marks degraded mode: "PRD converged (single-evaluator mode — codex unavailable)"

---

## Phase 5: GATE — final user confirmation

Display completed PRD + convergence summary, then AskUserQuestion with 4 options.

### 5.1 Presentation

```
# PRD Ready for Final Review

Convergence: {N} BRAINSTORM turns + {M} COVERAGE rounds → substantive_count 0
Evaluator mode: {dual | single-evaluator (degraded from round X)}
Deferred intents: {count} (if > 0, listed in PRD §8)

PRD sections (v1):
  §1 Product positioning ({L1} lines)
  §2 User roles / personas ({L2} lines)
  §3 Core user flows ({L3} lines)
  §4 Feature specifications ({L4} features)
  §5 NFR ({L5} items)
  §6 Technical constraints ({L6} items)
  §7 Scope boundaries
  §8 Assumptions & open risks ({L8} items)
  §9 Change history
```

### 5.2 Top-level AskUserQuestion

```
(1) Approve all, proceed to HANDOFF (recommended for converged PRD)
(2) Review per-section (open sequential AskUserQuestion for each §1-§9)
(3) Revise specific section — pass section number + comments
(4) Abort PRD
```

**Option 1**: proceed to Phase 6 HANDOFF.

**Option 2**: per-section loop. For each section §1 through §9, AskUserQuestion:
`Approve / Revise (pass comments) / Skip / Abort`. Skipped sections stay as-is; revised
sections re-enter Phase 4 COVERAGE for 1 verification round.

**Option 3**: user specifies which section + comments → AI revises → re-enter Phase 4
COVERAGE for 1 verification round. **Verification round DOES increment `phase_4_rounds_run`**;
counter is not reset. If this pushes `phase_4_rounds_run > 10`, trigger the standard
accept-at-limit flow (Phase 4 max_round handling).

**Option 4**: clean state, exit. Do NOT emit Phase 6 HANDOFF console.

---

## Phase 6: HANDOFF

### 6.1 Console output

```
PRD ready at docs/PRD.md

Convergence:
  BRAINSTORM turns: {N}
  COVERAGE rounds: {M}
  Final substantive count: 0
  Evaluator mode: {dual | single-evaluator}

Deferred intents: {count} (if > 0, see PRD §8 "Deferred intents")

Next steps:
  /spec docs/PRD.md      — generate ARCHITECTURE + MODULE specs (auto-assigns REQ-IDs)
  /prd status            — audit trail of this PRD session
```

(v2 will add `/prd add-feature` for incremental feature addition.)

### 6.2 State cleanup

```bash
rm -rf docs/.prd-state/
```

/prd exits. The HARD-GATE principle holds: do NOT auto-invoke `/spec`. User
decides when to proceed.

---

## Error handling

### Incomplete BRAINSTORM
User chose abort during Phase 1 → save state, exit. `/prd resume` can pick up.

### Phase 4 evaluator persistent failure
If Claude evaluator fails (Agent tool error) → stop loop, AskUserQuestion: "(1) Retry
Claude evaluator (2) Abort /prd — process failure unrecoverable". Don't attempt
silent recovery; evaluator output is load-bearing for convergence.

### Phase 5 abort mid-review
If user chose Abort during Option 2 per-section review → treat as Option 4 (clean
state, exit, no HANDOFF). Mark PRD.md as "Status: Draft" in §9.

---

## Design note: /prd vs /spec enforcement

/prd does NOT use PreToolUse hooks or phase-gated file access. Gates are AskUserQuestion
(blocking). Evaluator loops are instruction-level, not hook-enforced. This matches /spec's
enforcement model (lighter than /dev's hook-enforced phase gates) because /prd's risk
profile (writing a single markdown file) is low — not modifying source code.

The Iron Rule is instruction-level: evaluator Phase 4 SpecReview dimension detects
escape-hatch language and flags as Critical; user-facing AskUserQuestion forces
explicit user confirmation for all §7/§8 structured exceptions.
