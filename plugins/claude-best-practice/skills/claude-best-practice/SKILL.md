---
name: claude-best-practice
description: >
  Coaches Claude Code toward effective workflows: explore-plan-code discipline,
  verification-first development, context window management, prompt scoping,
  course correction patterns, and session strategy. Invoke when starting a
  complex session, when a session feels unproductive, or when onboarding
  someone to Claude Code best practices.
disable-model-invocation: true
metadata:
  author: Advance Studio
  version: "1.0"
  created: "2026-03-31"
  category: workflow
---

# Claude Code Best Practices

Apply these principles throughout the current session. They complement (not
duplicate) the rules in CLAUDE.md. Focus on *how* to work effectively, not
*what* to build.

---

## 1. Explore -> Plan -> Code

Never jump straight to coding. Separate research from execution.

**Phase 1 — Explore (read-only)**
- Read files, trace code paths, find existing patterns and utilities
- Use Plan Mode or subagents so exploration stays read-only
- Goal: understand the problem space before proposing solutions

**Phase 2 — Plan**
- Summarize findings, propose approach, identify verification criteria
- Get user confirmation before writing any code
- If exploration reveals the task is larger than expected: stop and re-scope
  rather than expanding mid-implementation

**Phase 3 — Code**
- Implement one concern at a time, in focused scope
- Reuse existing functions and patterns found during exploration
- Follow the plan; if you need to deviate, pause and re-plan

**When to skip planning:** Truly trivial tasks — typo fixes, single-line
changes, simple renames. If you could describe the diff in one sentence, just
do it.

---

## 2. Verification-First

Always know what "done" looks like before you start coding.

- **Tests**: Write or identify test cases before implementation. Run them after.
- **UI changes**: Take a "before" screenshot, describe expected "after" state,
  compare when done.
- **CLI/API work**: Define expected output before running.
- **Never declare "done"** without running the verification step.
- **Address root causes**: When fixing bugs, fix the underlying issue — don't
  suppress errors or work around symptoms.

If you can't verify it, don't ship it.

---

## 3. Context Management

Context window is the most precious resource. Performance degrades as it fills.

**Key habits:**
- `/clear` between unrelated tasks — a clean 200K window beats a polluted one
- `/compact <focus>` when context is long but still relevant — always provide a
  focus string ("keep the auth refactor context")
- `/btw` for tangential questions — prevents derailing the main task, stays out
  of conversation history
- **Subagents for investigation** — spawn a subagent to research a question
  without polluting main context
- If scrolling back to remember what you were doing, context is too large

**The two-correction rule** (see Section 5) also applies here: failed attempts
add noise. Clear early rather than accumulating.

See `references/CONTEXT-MANAGEMENT.md` for detailed decision trees.

---

## 4. Prompt Scoping

The more precise the instructions, the fewer corrections needed.

**Do:**
- Reference specific files: "follow the pattern in src/auth/middleware.ts"
- Scope narrowly: one task per prompt, one file at a time when possible
- Use constraints: "under 50 lines", "no new dependencies", "keep existing API"
- Provide the symptom + likely location + what "fixed" looks like
- Paste images, use `@file` references, pipe data with `cat file | claude`

**Don't:**
- "Make it better" (what dimension? performance? readability? UX?)
- "Fix the bug" (which bug? what's the symptom? where does it live?)
- Over-specify obvious things (Claude knows how to write a for loop)

**Vague prompts have their place**: when exploring and you can afford to
course-correct. "What would you improve in this file?" can surface things
you wouldn't think to ask about.

---

## 5. Course Correction

Correct early. Don't let Claude go far in the wrong direction.

- **`Esc`**: Stop mid-action immediately. Context is preserved — redirect.
- **`Esc + Esc` or `/rewind`**: Restore previous conversation and code state.
- **"Undo that"**: Revert last change.

**Two-correction rule**: If you've corrected Claude twice on the same issue
and it's still wrong, do NOT correct a third time. Instead:
1. `/clear`
2. Rewrite the prompt from scratch, incorporating what you learned
3. A clean session with a better prompt almost always outperforms a long
   session with accumulated corrections

Over-correction is an anti-pattern: each correction adds noise to context
and makes subsequent attempts worse, not better.

---

## 6. Session Strategy

**One concern per session.** Don't mix unrelated tasks in a single session.

**Parallel sessions for quality:**
- Writer/Reviewer pattern: one session implements, another reviews with fresh
  context (no bias toward its own code)
- Role separation: "you are a security reviewer", "you are a performance
  optimizer"
- Test-driven: one session writes tests, another writes code to pass them

**When to start fresh vs continue:**
- Continue: same task, context is still relevant and clean
- Fresh: different task, context is polluted, or you need unbiased review

**Resume with `--continue` or `--resume`.** Use `/rename` to label sessions
for later retrieval ("oauth-migration", "debugging-memory-leak").

See `references/PARALLEL-SESSIONS.md` for patterns and templates.

---

## 7. CLAUDE.md Hygiene

CLAUDE.md is loaded every session — keep it lean.

- **Only include rules Claude would break without the instruction.** If Claude
  already does something correctly, the rule is dead weight.
- **Prune regularly.** If a rule hasn't prevented a mistake in 2 weeks, remove
  it.
- **Don't duplicate** what skills handle or what linter configs enforce.
- **Style rules** belong in .editorconfig / .prettierrc / eslint config, not
  CLAUDE.md.
- **Treat it like code**: review when things go wrong, test whether changes
  actually shift behavior.
- **Add emphasis sparingly** ("IMPORTANT", "YOU MUST") for critical rules only.

If your CLAUDE.md is over ~40 lines, it's probably too long. Claude starts
ignoring rules when they compete for attention.

---

## 8. Self-Assessment Checklist

Mentally run through at task transitions:

**Before starting:**
- Did I explore the relevant code before planning?
- Is my plan scoped to one clear deliverable?
- Do I know what "done" looks like (test, screenshot, output)?

**During execution:**
- Am I past 2 corrections on this approach? -> /clear and rewrite
- Is context getting long? -> /compact with focus
- Am I drifting into a different task? -> finish current first

**Before declaring done:**
- Did I run the verification step?
- Did I check for regressions in related code?
- Is the change minimal — no unnecessary "improvements"?

---

## References

- `references/ANTI-PATTERNS.md` — common failure patterns and how to avoid them
- `references/CONTEXT-MANAGEMENT.md` — detailed /clear vs /compact decision tree
- `references/PARALLEL-SESSIONS.md` — Writer/Reviewer templates and role prompts
