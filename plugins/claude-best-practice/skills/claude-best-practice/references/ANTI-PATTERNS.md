# Anti-Patterns Catalog

Common failure patterns when using Claude Code. Each entry: smell, why it fails,
what to do instead.

---

## 1. Kitchen-Sink Session

**Smell**: You start with one task, ask something unrelated, then go back.
Context is full of irrelevant information.

**Why it fails**: Irrelevant context competes for attention. Claude may
reference the wrong task's code or lose track of constraints.

**Fix**: `/clear` between unrelated tasks. One session = one concern.

---

## 2. Over-Correction Spiral

**Smell**: You've corrected Claude 3+ times on the same issue. Each correction
makes the next attempt worse.

**Why it fails**: Each failed attempt stays in context. Claude tries to
reconcile contradictory approaches. Noise compounds.

**Fix**: Two-correction rule. After 2 failed corrections: `/clear`, rewrite
the prompt from scratch with what you learned. Clean context > patched context.

---

## 3. Over-Specified CLAUDE.md

**Smell**: CLAUDE.md is 100+ lines. Contains obvious rules like "use
descriptive variable names" or style rules that belong in linter configs.

**Why it fails**: Important rules get lost in noise. Claude starts ignoring
everything because nothing stands out.

**Fix**: Ruthlessly prune. For each line, ask: "Would removing this cause
Claude to make mistakes?" If not, delete it. Move style rules to linter configs.

---

## 4. Trust-Then-Verify Gap

**Smell**: Claude produces plausible-looking code. You accept it without
running tests or checking edge cases.

**Why it fails**: Claude optimizes for plausible-looking output. Without
verification, edge cases, race conditions, and subtle bugs slip through.

**Fix**: Define verification criteria BEFORE implementation. Run tests, check
screenshots, validate output. No verification = no ship.

---

## 5. Infinite Exploration

**Smell**: You ask Claude to "investigate" without scoping it. Claude reads
hundreds of files, filling context with information you don't need.

**Why it fails**: Context fills with exploration artifacts. By the time you
start implementing, the useful findings are buried.

**Fix**: Scope investigations narrowly ("look at src/auth/ and explain the
token refresh flow") or delegate to subagents so exploration doesn't consume
your main context.

---

## 6. Premature Implementation

**Smell**: Claude starts editing files within the first message. No exploration,
no plan, no understanding of existing patterns.

**Why it fails**: Without understanding the codebase, Claude reinvents existing
utilities, violates patterns, or solves the wrong problem entirely.

**Fix**: Explore -> Plan -> Code. Use Plan Mode to enforce read-only
exploration before any edits.

---

## 7. Context Hoarding

**Smell**: Session has been running for hours. You never `/clear` or `/compact`
because "the context might be useful later."

**Why it fails**: Performance degrades as context fills. Claude becomes less
accurate, more prone to hallucination, and slower to respond.

**Fix**: `/clear` aggressively. If you need context later, it's in the files
and git history. A clean window with a good prompt recovers faster than a
degraded window with stale context.
