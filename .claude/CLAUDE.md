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
- /dev supports worktree-parallel execution (2.8.0+): 4 subcommands `worktree-new` / `worktree-list` / `worktree-finish` / `worktree-remove` backed by `plugins/dev/bin/worktree-helper.sh`. `/spec` and `/prd` stay single-flight — use them only in the main worktree. §2.1.2 / §0.6 upstream-change checks emit worktree bridging hints (cd + git commit + git rebase using local ref via shared `.git/` object store) BELOW the frozen 4-command Option A / 3-command Option B blocks. The blocks themselves are UNCHANGED from 2.7.0; see /dev SKILL.md §8 for bridging details. Known operational quirks: shared `.git/index.lock` contention (git auto-retries); `stop.sh` MAY auto-push `dev-task-*` branches to origin — exact conditions depend on multiple gates (remote configured, clean-vs-dirty tree, staging-result, gitleaks, upstream-ahead). See SKILL.md §8.3 rule 5 for the authoritative 5-gate description. Task branches are NOT "local by default" in repos with origin.
- System-acceptance / witness-contract layer (2.10.0+): closes the "module AC 92% but the wired system never runs" gap with a SECOND progress axis. A `Witness: unit|integration|e2e` field on REQ (REQUIREMENTS_REGISTRY, orthogonal to Type) marks which requirements need whole-system proof; every `Witness:e2e` REQ must map to ≥1 `SYS-J` journey in the standalone `docs/SYSTEM-ACCEPTANCE.md` (`/spec` Phase 3.4, after CONTEXT-MAP 3.3 — NOT renumbered), whose §2 `SYS-AC` ledger mirrors MODULE §3.4. `/spec` Phase 1.3 adds a `system_coverage==100%` convergence gate (catches under-classification + missing cross-module paths; 3.0.0 also discovers **emergent journeys** no single REQ captures, loop-until-dry). `/dev` adds `in_scope_sys_ac_ids` (state.json v5, additive), a DoD **System Acceptance** hard gate (a `Witness:e2e` REQ caps at `Partial` until its `SYS-AC` passes on a REAL wired run — not mocked; gate fires only when `in_scope_sys_ac_ids` non-empty, so pure module tasks are never blocked), and a two-axis SUMMARY + `board.sh` metric (module AC coverage AND system E2E readiness, **never merged**). PRD §3 flows seed it via a `System acceptance journey: Yes/No` marker (Phase 4 Dim 1 check). All frozen contracts + bump classes live in VERSIONING.md "Release checklist (for system-acceptance layer — 2.10.0+)". Existing projects adopt the layer **without a full `/spec` rerun** via `/spec upgrade-template` (2.11.0+, Phase UT.10; **3.0.0 evaluator-backed**): injects the registry `Witness` column (existing REQs default `unit`) + bootstraps/merge-preserves `docs/SYSTEM-ACCEPTANCE.md`. As of 3.0.0, UT.10.A step 4 runs **evaluator-backed journey discovery** (Phase-1.3 dual-evaluator, loop-until-dry — under-classified REQs + emergent journeys; degrades single→heuristic), deliberately breaking the prior 2.11.0 "no evaluator loops" freeze (the MAJOR bump); it still does NOT regenerate ARCHITECTURE/modules (that stays full-`/spec`-rerun territory). idempotent; UT.10 never writes a SYS-AC `passed` (authorship partition preserved); e2e marking still needs the explicit UT.10.A step-5 policy prompt.
- Version-drift visibility (2.12.0+): every `/spec` `/prd` `/dev` invocation runs a Phase 0 banner (`plugins/dev/bin/dev-version-banner.sh <skill> X.Y.Z`, read-only, always exits 0) printing the running dev-template version and warning when a newer plugin was installed mid-session (session↔installed drift — compares the SKILL.md session-bound literal to on-disk `plugin.json`; semver-correct via python3, not `sort -V`). `/spec` + `/prd` stamp every generated doc header with `> dev-template: vX.Y.Z` (filled at write-time from the banner version) and, on rerun, read the anchor doc's stamp (ARCHITECTURE.md for /spec, PRD.md for /prd) to flag artifact drift → pointing at `/spec upgrade-template` or regenerate. The 3 SKILL.md banner literals are sync points (VERSIONING Hard rule 5 → **8 sync points**, not 5). `check-phase.sh` carries one narrow read-only allowance (a `^…$`-anchored regex forbidding shell metacharacters) so the banner runs even on `/dev resume`/`status` into a locked phase. REQUIREMENTS_REGISTRY.md and ADRs are deliberately NOT stamped. All frozen contracts live in VERSIONING.md "Release checklist (for version-drift visibility — 2.12.0+)".

## Test command

There is no automated test suite — this repo is markdown + shell + JSON. Syntax-lint
plus a runtime smoke for the read-only `/dev board` aggregator:

```bash
bash -n plugins/dev/bin/*.sh plugins/dev/skills/dev/bin/*.sh && \
  jq -e . .claude-plugin/marketplace.json plugins/dev/.claude-plugin/plugin.json \
    plugins/dev/hooks/hooks.json > /dev/null && \
  bash plugins/dev/bin/board.sh > /dev/null && \
  bash plugins/dev/bin/dev-version-banner.sh dev 3.0.0 > /dev/null
```

The board.sh runtime smoke (2.9.0+) catches awk/jq pipeline regressions that
`bash -n` cannot, while remaining side-effect-free (board.sh is read-only by
contract — see `plugins/dev/skills/dev/SKILL.md` §7.2). The `bash -n` glob now also
covers `skills/dev/bin/check-phase.sh` (the PreToolUse phase gate), and the
`dev-version-banner.sh` runtime smoke (2.12.0+) exercises the read-only version-drift
banner (also side-effect-free, always exits 0).

Semantic correctness for skill-markdown changes falls on dual-model evaluator review
(the `/dev` workflow handles this automatically).
