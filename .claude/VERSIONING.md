# Versioning policy — advance-kit plugins

This policy governs version bumps for every plugin in `plugins/` (currently `dev`,
`claude-best-practice`, `code-companion`). It is imported by `.claude/CLAUDE.md` so all
Claude-driven changes follow it without per-turn negotiation.

## SemVer adapted to Claude Code plugins

`public surface` = anything a downstream user of the plugin can observe: skill markdown
instructions (because they change agent behaviour), `hooks.json` config, `bin/` script
interfaces, the MODULE template /spec produces, and `state.json` schemas.

| Change class | Bump | Examples |
|---|---|---|
| **Patch** `X.Y.Z+1` | | |
| Fix a skill logic bug without changing instruction semantics | Z | unwire a broken Notification hook |
| Internal refactor with externally-equivalent behaviour | Z | rename obsolete `§14` references to `§3.x` that the agent already produces |
| Typo / README clarification / comment | Z | pure docs |
| Version-number resync (plugin.json ↔ marketplace.json ↔ READMEs) | Z | recover from drift |
| **Minor** `X.Y+1.0` | | |
| Add a new section to the /spec MODULE template | Y | new `§2.12 State Management`, `§3.8 Implementation Notes` in 2.1.0 |
| Add a new /dev phase / gate / evaluator / sub-command | Y | hypothetical `/dev perf-bench` |
| Wire a new hook event (Notification / PreCompact / etc.) | Y | — |
| Add a new agent capability that preserves all old flows | Y | — |
| **Major** `X+1.0.0` | | |
| Remove or rename a /spec template section (downstream MODULE docs break) | X | delete `§2.4 API Endpoints` |
| Breaking `state.json` schema change (existing state can't resume) | X | reshape the `phase` enum |
| Breaking `hooks.json` change (existing configs fail to load) | X | rename a hook event |
| Remove a skill or subcommand | X | delete `/dev doctor` |

## Hard rules

1. **Plugin version and marketplace entry must move together.** Every
   `plugins/<name>/.claude-plugin/plugin.json` version must equal the corresponding
   `.claude-plugin/marketplace.json` entry's version. Never ship a mismatch.

2. **All three README status tables stay in sync.** `README.md`, `README.zh-CN.md`,
   and `README.es.md` carry a plugin-version column that must match the above two files.
   This is checked by evaluator greps (e.g., /dev 2.0.2/2.1.0 tests T13/T14).

3. **Bump and push on convergence.** When a `/dev` workflow converges on a plugin
   change, bump the version in the same commit as the change — not as a separate
   follow-up. Never accumulate unreleased plugin changes in main.

4. **No version skips within a plugin.** Follow the sequence (e.g., don't jump 2.0.2 → 2.2.0
   without a 2.1.x cycle in between, unless the change is genuinely Major).

## Release cadence (recommended, currently unformalized)

- After push, consider a git tag `{plugin}-v{version}` (e.g., `dev-v2.1.0`) and a
  GitHub release. Tags 1.1.1–1.1.3 exist historically; 1.2.0 onwards have no tags.
  Restarting this is optional but makes rollback / provenance easier.

## When in doubt

If a change sits on the boundary between two tiers (e.g., a minor refactor that happens
to touch user-visible wording), round **up** to the safer tier (minor over patch,
major over minor). The cost of a too-high bump is cosmetic; the cost of a too-low bump
is hidden breakage for downstream users.
