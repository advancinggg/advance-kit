# advance-kit

A Claude Code plugin marketplace by [Advance Studio](https://github.com/anthropic-f).

## Plugins

### dev

Enforced dev workflow with dual-model review and phase-gated file access control.

**Skills:**
- `/dev [task]` — Full lifecycle: plan → docs → implement → audit → test → summary
- `/dev:sdd [path]` — Specification Driven Development: PRD → architecture → module specs → implementation order

**Agents:**
- `claude-auditor` — Isolated-context reviewer for dual-model code/plan/security review

**Commands:**
- `/dev:setup` — Install optional dependencies (Codex) for dual-model review

### claude-best-practice

Coaching skill for effective Claude Code workflows. Loaded as background context (not user-invoked).

Covers: explore-plan-code discipline, verification-first development, context management, prompt scoping, course correction, and session strategy.

## Install

```bash
# 1. Add the marketplace (one-time)
claude plugin marketplace add <github-user>/advance-kit

# 2. Install plugins
claude plugin install dev@advance-kit
claude plugin install claude-best-practice@advance-kit

# 3. (Optional) Install dependencies for dual-model review
/dev:setup
```

## Update

```bash
claude plugin update dev
claude plugin update claude-best-practice
```

## Optional Dependencies

The `dev` plugin supports dual-model review (Claude + Codex). Without Codex, it falls back to single-model review.

To enable dual-model review:
1. Install [Codex CLI](https://github.com/openai/codex)
2. Run `/dev:setup` to install the Codex plugin automatically

## License

MIT
