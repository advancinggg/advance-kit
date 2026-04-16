<p align="center">
  <img src="docs/assets/banner.png" alt="Advance" width="640">
</p>

<p align="center">
  <strong>Rigorous development workflows for Claude Code.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/advancinggg/advance-kit/releases"><img src="https://img.shields.io/github/v/release/advancinggg/advance-kit?include_prereleases&style=for-the-badge" alt="Latest release"></a>
  <a href="https://github.com/advancinggg/advance-kit/stargazers"><img src="https://img.shields.io/github/stars/advancinggg/advance-kit?style=for-the-badge" alt="GitHub stars"></a>
  <a href="https://x.com/Advancinggg"><img src="https://img.shields.io/badge/follow-%40Advancinggg-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow @Advancinggg on X"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin%20marketplace-7c3aed?style=for-the-badge" alt="Claude Code plugin marketplace">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a>
</p>

---

## Overview

**advance-kit** is a [Claude Code](https://github.com/anthropics/claude-code) plugin
marketplace by Advance Studio. It bundles three production-grade plugins that turn
Claude Code from a helpful assistant into a disciplined engineering collaborator:
specification-driven planning, dual-model cross-audit, phase-gated file access, and a
native macOS status surface for approvals.

## Plugins

### `dev` — Enforced development workflow

Enforces the full lifecycle **plan → docs → implement → audit → test → summary** on
every development task. A `PreToolUse` hook gates file access per phase so the main
agent cannot skip ahead or silently mutate files outside the current step.

- **Dual-model review** — every audit point runs a Claude subagent (isolated context)
  *and* a Codex exec pass (agent exploration), then merges findings across models.
- **Independent evaluator architecture** — the plan / audit / test / adversarial phases
  spawn fresh evaluators every round with zero implementation context, using
  structured convergence metrics (`substantive_count`, `pass_rate`) as the objective
  decision criterion.
- **Spec-driven module decomposition** — the bundled `/spec` skill turns a PRD into an
  architecture document plus self-contained MODULE specs, ready to hand off to an AI
  agent for implementation.
- **Cross-module regression gates** — when a task touches a contract declared in
  `ARCHITECTURE.md §6.1`, the workflow reverse-looks-up downstream modules and runs
  the Regression Check against their historically verified AC ledger.

**Skills:**
- `/dev [task description]` — run the full enforced workflow
- `/dev status | resume | abort | doctor` — inspect, resume, or reset an in-progress run
- `/spec [path/to/PRD.md]` — generate architecture and MECE module specs from a PRD

**Agents:**
- `claude-auditor` — isolated-context reviewer used for every audit point

**Commands:**
- `/dev:setup` — install optional dependencies (Codex CLI) for dual-model review

### `claude-best-practice` — Coaching context

Background skill (not user-invoked) that teaches Claude Code the core discipline of
working inside a real codebase: explore-plan-code sequencing, verification-first
development, context management, prompt scoping, course correction, and session
strategy. Loads automatically as reference material rather than as a slash command.

### `code-companion` — macOS Dynamic Island for code agents

A native macOS floating status pill that surfaces pending approvals and active
sessions across Claude Code, Codex, and Gemini CLI. Click a notification to jump
straight to the originating terminal, with rich context about what is waiting for you.

## Installation

```bash
# 1. Add the marketplace (one-time)
claude plugin marketplace add advancinggg/advance-kit

# 2. Install the plugins you want
claude plugin install dev@advance-kit
claude plugin install claude-best-practice@advance-kit
claude plugin install code-companion@advance-kit

# 3. (Optional) Install dependencies for dual-model review
/dev:setup
```

## Update

```bash
claude plugin update dev
claude plugin update claude-best-practice
claude plugin update code-companion
```

## Optional dependencies

The `dev` plugin supports dual-model review (Claude + Codex). Without Codex it
falls back to single-model review automatically and annotates audit conclusions as
`single-model`.

To enable dual-model review:

1. Install the [Codex CLI](https://github.com/openai/codex).
2. Run `/dev:setup` to pull in the matching Codex plugin.
3. Verify with `/dev doctor`.

## Optional: statusline

The `dev` plugin ships a two-line statusline (context usage, 5-hour & 7-day rate
limits, model name, token counts). Claude Code only loads `statusLine` from user
settings — plugins cannot declare it — so wire it up yourself:

```bash
# 1. Install the script to a stable path
mkdir -p ~/.claude/bin
curl -fsSL https://raw.githubusercontent.com/advancinggg/advance-kit/main/plugins/dev/bin/statusline.sh \
  -o ~/.claude/bin/statusline.sh
chmod +x ~/.claude/bin/statusline.sh
```

Then add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/bin/statusline.sh",
    "padding": 1
  }
}
```

## Project status

| Plugin | Version | Status |
|---|---|---|
| `dev` | `2.0.2` | Stable — AC-based module progress formula; includes `dev` and `spec` skills, plus opt-in statusline |
| `claude-best-practice` | `1.0.0` | Stable |
| `code-companion` | `1.0.0` | Stable (macOS only) |

## Contact

- **X / Twitter**: [@Advancinggg](https://x.com/Advancinggg)
- **Email**: [admin@advance.studio](mailto:admin@advance.studio)

Bug reports and feature requests are welcome via
[GitHub Issues](https://github.com/advancinggg/advance-kit/issues).

## License

[MIT](LICENSE) © Advance Studio
