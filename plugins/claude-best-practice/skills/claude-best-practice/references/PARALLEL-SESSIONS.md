# Parallel Session Patterns

Strategies for running multiple Claude Code sessions to improve quality and
throughput.

---

## Pattern 1: Writer / Reviewer

Two sessions, sequential handoff.

| Session A (Writer) | Session B (Reviewer) |
|---------------------|----------------------|
| Implement the feature | (wait for A to finish) |
| | Review the implementation for edge cases, race conditions, patterns |
| Address review feedback | |

**Why it works**: Session B has fresh context — no bias toward its own code.
Review quality is dramatically higher than self-review in the same session.

**Invoke**: After implementing, open a new session:
```
Review the implementation in @src/feature/. Look for edge cases, race
conditions, and consistency with existing patterns. Be adversarial.
```

---

## Pattern 2: Test-Driven Pair

One session writes tests, another writes implementation.

| Session A (Test Writer) | Session B (Implementer) |
|--------------------------|-------------------------|
| Write comprehensive tests from the spec | (wait for A) |
| | Implement code to pass all tests |
| Verify tests pass, add edge case tests | Fix failures |

**Why it works**: Tests written without implementation bias cover more edge
cases. Implementation guided by tests stays focused.

---

## Pattern 3: Role Separation

Multiple sessions with different expertise lenses.

- **Security reviewer**: "You are a senior security engineer. Review for
  injection, auth flaws, secrets in code, insecure data handling."
- **Performance optimizer**: "You are a performance engineer. Profile this
  code path, identify bottlenecks, suggest optimizations."
- **Architecture reviewer**: "You are a system architect. Review this design
  for coupling, scalability, and maintainability."

**When to use**: Before merging significant features. Each role catches
different classes of issues.

---

## Pattern 4: Fan-Out for Migrations

Distribute bulk work across parallel non-interactive sessions.

```bash
for file in $(cat files-to-migrate.txt); do
  claude -p "Migrate $file from pattern A to pattern B. Return OK or FAIL." \
    --allowedTools "Edit,Bash(git commit *)" &
done
wait
```

**Tips**:
- Test on 2-3 files first, refine the prompt
- Use `--allowedTools` to restrict what each session can do
- Collect results and review failures manually

---

## When NOT to Parallelize

- Tasks with tight dependencies (file A's change affects file B)
- When you need to iterate on the approach (use one session, get it right)
- Simple tasks that are faster to do sequentially than to coordinate
