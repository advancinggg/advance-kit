# Context Management Strategies

Detailed decision trees and patterns for managing Claude Code's context window.

---

## Decision Tree: /clear vs /compact vs /btw

```
Need to ask a quick tangential question?
  -> /btw (stays out of history, no context cost)

Switching to an unrelated task?
  -> /clear (full reset, clean slate)

Same task, but context is long and noisy?
  -> /compact "focus on X" (summarize, keep relevant parts)

Same task, want to undo recent exploration?
  -> Esc+Esc or /rewind (restore checkpoint, selective rollback)
```

---

## When to /clear

- Between unrelated tasks (always)
- After 2 failed correction attempts on the same issue
- When you notice Claude repeating itself or contradicting earlier statements
- Before starting a review of code Claude just wrote (fresh eyes)
- When context usage indicator shows > 70% and task is not near completion

---

## When to /compact

- Long debugging session where the bug context is still relevant
- Multi-file refactor where you need to remember the plan
- Always provide a focus string: `/compact keep the migration plan and modified files list`
- Customize in CLAUDE.md: "When compacting, always preserve the full list of
  modified files and any test commands"

---

## Subagent Strategy

Use subagents for investigation to keep main context clean:

**Good subagent tasks:**
- "Search the codebase for all auth patterns and summarize"
- "Read the test files and explain the testing conventions"
- "Review this implementation for edge cases"

**Bad subagent tasks (do these in main context):**
- Simple, single-file reads
- Tasks that require back-and-forth with the user
- Final implementation (needs the full plan context)

**Pattern**: Research in subagent -> summary back to main -> implement in main.

---

## Rewind Strategy

Claude checkpoints every file change. Use `/rewind` to:

- **Restore conversation only**: keep code changes, reset chat context
- **Restore code only**: keep conversation, undo file changes
- **Restore both**: full rollback to a checkpoint
- **Summarize from here**: condense messages from a point forward

This is cheaper than `/clear` + re-explaining because it preserves the
useful earlier context while removing the noise.
