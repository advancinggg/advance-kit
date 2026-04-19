# advance-kit — repo guide for Claude Code

This repo is the **advance-kit** Claude Code plugin marketplace by Advance Studio.
It ships three plugins — `dev`, `claude-best-practice`, `code-companion` — via the
`.claude-plugin/marketplace.json` manifest and per-plugin sources under `plugins/`.

## Layout

| Path | Role |
|---|---|
| `.claude-plugin/marketplace.json` | marketplace manifest (plugin list + versions) |
| `plugins/dev/` | the `dev` plugin — enforced workflow + spec skill + hooks + auditor agent |
| `plugins/claude-best-practice/` | reference context skill (loaded as material, not invoked) |
| `plugins/code-companion/` | macOS Dynamic Island app for code-agent approvals |
| `README.md` / `README.zh-CN.md` / `README.es.md` | user-facing docs in 3 languages |

## Rules for any change inside this repo

Before bumping any version, renaming any plugin section, or publishing a new release,
read the versioning policy below. Every version number in `plugin.json`,
`marketplace.json`, and the three READMEs' status tables must move together; the policy
defines when to bump patch / minor / major.

@VERSIONING.md

## Skill development notes

- `plugins/dev/skills/dev/SKILL.md` and `plugins/dev/skills/spec/SKILL.md` use a
  three-part §1.x / §2.x / §3.x numbering scheme for MODULE docs (Part 1 Requirements,
  Part 2 Specification, Part 3 Implementation). Historical single-segment `§1 … §14`
  references were fully migrated in 2.1.0 — do not re-introduce them.
- The `/dev` progress formula lives in `/dev` SKILL.md §6.1.1 and reads only from MODULE
  doc §3.4 (`count(Active=Y AND Status='passed') / count(Active=Y) × 100`). The §3.4
  ledger has a partitioned authorship contract: `/spec` owns row creation and
  Active=Y↔N flips; `/dev` SUMMARY owns only `untested → passed`.
- The Iron Rule (dev/SKILL.md:61–69) forbids "Known gaps / Out-of-Scope / Deferred /
  TODO for you / v2 deferred / Skip for now" in any phase output. The only legitimate
  "unfixed" path is `deferred_findings` with a `user_accepted_at` timestamp, produced
  after exceeding `max_round` via explicit AskUserQuestion.
- /dev DOCS phase fires three inline upstream checks in order: §2.1.1 (ADR discovery, 2.5.0+), §2.1.2 (PRD/cross-module-spec discovery, 2.7.0+), §2.1.3 (Core Logic drift, 2.7.0+ — re-entry DOCS only). All three use AskUserQuestion; §2.1.1 and §2.1.2 use the abort+restart pattern that prints commands and exits. Lightweight mode (`sdd_mode: false`) skips all three alongside Phase 2 DOCS.

## Test command

There is no automated test suite — this repo is markdown + shell + JSON. Syntax-lint
only:

```bash
bash -n plugins/dev/bin/*.sh && \
  jq -e . .claude-plugin/marketplace.json plugins/dev/.claude-plugin/plugin.json \
    plugins/dev/hooks/hooks.json > /dev/null
```

Semantic correctness for skill-markdown changes falls on dual-model evaluator review
(the `/dev` workflow handles this automatically).
