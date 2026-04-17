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

## Release checklist (for /spec template changes)

When editing the Phase 1.2 ARCHITECTURE template or the Phase 2.2 MODULE template in
`plugins/dev/skills/spec/SKILL.md`, update the Phase UT synchronized structures in
the same commit:

1. **Canonical section list** (`module_sections` / `arch_sections` YAML in Phase UT) —
   add/remove/retitle entries to mirror the live template headings.
2. **R5 legacy-body marker phrases** — if you reword any of the short phrases used in
   §2.12 State Management or §3.8 Implementation Notes template bodies (e.g.,
   `"Owned state surfaces"`, `"State transitions"`, `"Cross-module state protocol"`,
   `"Alternatives considered"`, `"Trade-off"`), update the marker set in the Phase UT
   R5 check so legacy-body collision detection stays accurate.

The /dev test phase evaluators run T12 / T13 / T18 against the upgraded skill;
structural drift between canonical lists and live templates fails T12/T13 and blocks
convergence. (There is no CI pipeline — this guard runs under /dev's dual-model
evaluator loop, not an automated CI.)

**Anchor-collision invariant for Phase UT**: the UT.4 body-lookup protocol searches for
the exact lines `### 1.2 Architecture Document Structure` and `### 2.2 Unified Module
Document Template` as real headings (outside all code fences). **Do not start any new
line with either of these strings outside a code fence** when editing Phase UT prose,
the canonical YAML, or other sections of SKILL.md. Prose references must either use
backtick-wrapping (e.g., `` `### 2.2 Unified Module Document Template` ``) or mention
the heading inside a fenced code block. Violations create false anchors that silently
break upgrade-template's body lookup for Missing sections.
