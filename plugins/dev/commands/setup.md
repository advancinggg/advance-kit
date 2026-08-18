---
description: Install optional dependencies for the dev plugin (claude+codex review backend; not needed under Grok Build).
allowed-tools: [Bash, Read]
---

# /dev:setup — Install Dependencies

Check and install optional dependencies for the dev workflow plugin.

> **Grok Build note (3.10.0+)**: under Grok Build, `/dev` auto-selects the `grok-dual`
> review backend (two native `spawn_subagent` evaluators) — the codex CLI and plugin
> below are NOT used there and nothing needs installing. This setup applies to the
> `claude+codex` backend (Claude Code / compatible harnesses).

## Dependencies

| Dependency | Purpose | Required |
|-----------|---------|----------|
| codex CLI | Cross-model code review via Codex exec (claude+codex backend) | Optional (degrades to single-evaluator) |
| codex@openai-codex plugin | Codex integration for Claude Code | Optional |

## Instructions

Run the following checks and install missing dependencies:

### 1. Check codex CLI

```bash
which codex 2>/dev/null && echo "CODEX_CLI: INSTALLED" || echo "CODEX_CLI: NOT_FOUND"
```

- If `INSTALLED`: proceed to step 2.
- If `NOT_FOUND`: inform the user that codex CLI needs to be installed separately
  (see https://github.com/openai/codex) and skip to step 3.

### 2. Check and install codex plugin

```bash
cat ~/.claude/plugins/installed_plugins.json 2>/dev/null | jq -r '.plugins["codex@openai-codex"] // empty'
```

- If output is not empty (already installed): report as installed, skip install.
- If empty (not installed), run these commands sequentially:

```bash
claude plugin marketplace add openai/codex-plugin-cc
```

```bash
claude plugin install codex@openai-codex
```

### 3. Report

Show a summary:

```
/dev:setup — Dependency Status

  codex CLI:     {INSTALLED | NOT_FOUND — install from https://github.com/openai/codex}
  codex plugin:  {INSTALLED | JUST INSTALLED | SKIPPED (no codex CLI)}

  claude+codex cross-model review: {ENABLED | DISABLED (single-evaluator fallback)}
```

If all dependencies are installed, output:
```
All dependencies are installed. Cross-model review (claude+codex backend) is enabled.
```

If running under Grok Build, output instead:
```
Grok Build detected — /dev uses the grok-dual backend (native subagents); nothing to install.
```
