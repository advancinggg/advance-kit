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
- The `/dev` progress formula lives in `/dev` SKILL.md §6.1.1 and reads from MODULE doc §3.4
  (`count(Active=Y AND Status='passed') / count(Active=Y) × 100`). **3.7.0/K10 makes §1.5 the
  authoritative AC declaration source and requires §3.4 to stay in bijection with it**, fixing the
  desync class where an AC declared in §1.5 but row-pending in §3.4 let a REQ over-claim `Verified`.
  The §3.4 ledger now has a **refined** (additive) partitioned authorship contract: `/dev` DOCS
  **births** the `Active=Y, untested` stub row for each AC it declares in §1.5 (same commit, no
  deferral); `/spec` owns Criterion-change `Active=Y↔N` flips + rerun merge-preserve + **terminal
  set-equality self-heal** (back-fills any legacy §1.5-without-§3.4 desync as `untested`, deprecates
  removed AC `Active=N` — never fabricates `passed`); `/dev` SUMMARY owns only `untested → passed`.
  The three decision gates are now **§1.5-authoritative + fail-closed**: DOCS exit invariant (every
  touched/added §1.5 AC has a §3.4 row), SUMMARY enumerates the Active=Y AC set from §1.5 and counts
  a missing §3.4 row as `untested` (capping the REQ at `Partial`, emitting `ledger_desync`), §6.1.1
  is a hard parity precondition (not advisory), and the `/spec` module evaluator (Claude+Codex)
  checks §1.5↔§3.4 bijection + witness parseability with `parity_violations == 0` as a convergence
  condition. A new **Ledger Parity** DoD dimension makes the over-claim class structurally
  impossible. **3.8.0/K11 makes the DOCS exit invariant MECHANICAL**: `check-phase.sh` (the
  PreToolUse gate) runs `skills/dev/bin/ledger-parity-check.sh` the moment a `state.json` write
  flips `phase` out of `docs`, and DENIES the transition if any in-scope module's §1.5 AC has no
  §3.4 row (naming the orphan AC-IDs). It is a **fail-OPEN correctness gate** (lightweight mode /
  unparseable doc / missing file → allow; it never hard-blocks /dev), **scoped to the modules this
  run touched** (`docs_allowlist` ∪ `in_scope_ac_ids` prefixes), denying only on a confirmed
  desync. All frozen contracts live in VERSIONING.md "Release checklist (for §1.5↔§3.4 ledger
  parity — 3.7.0+)".
- The Iron Rule (dev/SKILL.md §0 + spec §0) forbids softening a live evaluator finding via
  free-form "Known gaps / Out-of-Scope / Deferred / TODO / v2 deferred / Skip for now". **3.4.0/K6
  adds the discriminator**: softening a finding (FORBIDDEN) vs declaring a tool/scope/run BOUNDARY
  (REQUIRED honest disclosure). The legitimate "unfixed" records are `deferred_findings` (+ K4's
  `system_acceptance_deferred`), each carrying a `user_accepted_at` (produced after `max_round` via
  explicit AskUserQuestion); and every completion summary (/dev SUMMARY, /spec Final Report + UT.9,
  /prd HANDOFF) carries a structured **"Scope & unverified"** field sourced ONLY from sanctioned
  state (`waived_scope` / deferred records / degraded-mode flags / `Partial` REQs) — never
  free-form, else it becomes the very escape hatch the rule forbids.
- /dev DOCS phase fires three inline upstream checks in order: §2.1.1 (ADR discovery, 2.5.0+), §2.1.2 (PRD/cross-module-spec discovery, 2.7.0+), §2.1.3 (Core Logic drift, 2.7.0+ — re-entry DOCS only). All three use AskUserQuestion; §2.1.1 and §2.1.2 use the abort+restart pattern that prints commands and exits. Lightweight mode (`sdd_mode: false`) skips all three alongside Phase 2 DOCS.
- /dev supports worktree-parallel execution (2.8.0+): 4 subcommands `worktree-new` / `worktree-list` / `worktree-finish` / `worktree-remove` backed by `plugins/dev/bin/worktree-helper.sh`. `/spec` and `/prd` stay single-flight — use them only in the main worktree. §2.1.2 / §0.6 upstream-change checks emit worktree bridging hints (cd + git commit + git rebase using local ref via shared `.git/` object store) BELOW the frozen 4-command Option A / 3-command Option B blocks. The blocks themselves are UNCHANGED from 2.7.0; see `plugins/dev/skills/dev/references/worktree.md` (§8 body, moved there in 3.9.0) for bridging details. Known operational quirks: shared `.git/index.lock` contention (git auto-retries). **3.9.0**: `stop.sh` and `git-auto-pull.sh` STAND DOWN entirely while any workflow state file exists (`.dev-state/state.json`, `docs/.spec-state/progress.json`, `docs/.prd-state/progress.json`) — no mid-run auto-commit/push/rebase, protecting the deterministic `start_commit..HEAD` audit target. Outside active workflows `stop.sh` MAY still auto-push (now 6 gates, incl. an outgoing-COMMIT gitleaks scan (`git log -p`) on the clean-tree fast path and a remote derived from `git config branch.<b>.remote` (local/empty → origin)); see `references/worktree.md` §8.3 rule 5 for the authoritative description. `worktree-finish` prints a post-merge ledger-reconciliation step (§8.3 rule 6).
- System-acceptance / witness-contract layer (2.10.0+): closes the "module AC 92% but the wired system never runs" gap with a SECOND progress axis. A `Witness: unit|integration|e2e` field on REQ (REQUIREMENTS_REGISTRY, orthogonal to Type) marks which requirements need whole-system proof; every `Witness:e2e` REQ must map to ≥1 `SYS-J` journey in the standalone `docs/SYSTEM-ACCEPTANCE.md` (`/spec` Phase 3.4, after CONTEXT-MAP 3.3 — NOT renumbered), whose §2 `SYS-AC` ledger mirrors MODULE §3.4. **3.1.0** decomposes each journey into atomic, independently-adjudicable SYS-AC (≥1 functional + NFR/SLO + error-path) defined in a `SYSTEM-ACCEPTANCE.md` **§1.1** criteria table (criterion text in §1.1; §2 stays status-only + 2-digit IDs unchanged — Path C, additive MINOR; mirrors MODULE §1.5↔§3.4). `/spec` Phase 1.3 adds a `system_coverage==100%` convergence gate (catches under-classification + missing cross-module paths; 3.0.0 also discovers **emergent journeys** no single REQ captures, loop-until-dry). `/dev` adds `in_scope_sys_ac_ids` (state.json v6, additive), a DoD **System Acceptance** hard gate (a `Witness:e2e` REQ caps at `Partial` until its `SYS-AC` passes on a REAL wired run — not mocked; gate fires only when `in_scope_sys_ac_ids` non-empty, so pure module tasks are never blocked), a **system-acceptance harness** (3.2.0/K4: `sysac_harness_cmd` declares/detects how to bring up + run the wired system for SYS-AC e2e; PLAN requires it when e2e SYS-AC are in scope) + an explicit user-accepted `system_acceptance_deferred` path (witness-floor preserved — a deferral NEVER marks `passed`; the REQ stays Partial + readiness <100% with a recorded reason, so the gap is surfaced not hidden) so e2e REQs aren't permanently stuck when the wired system can't run in an environment, and a two-axis SUMMARY + `board.sh` metric (module AC coverage AND system E2E readiness, **never merged**). PRD §3 flows seed it via a `System acceptance journey: Yes/No` marker (3.5.0/K7: REQUIRED on EVERY §3 flow — Phase 4 Dim 1 flags a missing marker, distinct from its "non-trivial product ⇒ ≥1 Yes" check; a legacy backfill batched-classifies any unmarked §3 flows (pre-2.10.0 or partially-marked PRDs), user-classified, without a full regenerate). All frozen contracts + bump classes live in VERSIONING.md "Release checklist (for system-acceptance layer — 2.10.0+)". Existing projects adopt the layer **without a full `/spec` rerun** via `/spec upgrade-template` (2.11.0+, Phase UT.10; **3.0.0 evaluator-backed**): injects the registry `Witness` column (existing REQs default `unit`) + bootstraps/merge-preserves `docs/SYSTEM-ACCEPTANCE.md`. As of 3.0.0, UT.10.A step 4 runs **evaluator-backed journey discovery** (Phase-1.3 dual-evaluator, loop-until-dry — under-classified REQs + emergent journeys; degrades single→heuristic), deliberately breaking the prior 2.11.0 "no evaluator loops" freeze (the MAJOR bump); it still does NOT regenerate ARCHITECTURE/modules (that stays full-`/spec`-rerun territory). idempotent; UT.10 never writes a SYS-AC `passed` (authorship partition preserved); e2e marking still needs the explicit UT.10.A step-5 policy prompt.
- Enforcement repair + loop hardening (3.9.0): the PreToolUse gate's deny/ask decisions are emitted as `hookSpecificOutput.permissionDecision` (the ONLY shape Claude Code honors — a bare top-level `permissionDecision` is zod-stripped and the gate silently fails open, which was the pre-3.9.0 state; never revert the emitters). Companion fixes: semantic DOCS-exit flip detection (post-edit reconstruction, not payload grep), a corrupt-state repair channel (state-file writes allowed so `/dev doctor` can't deadlock), NotebookEdit matcher, locked-phase command-substitution + write-flag denials, summary-phase carve-outs for `docs/ARCHITECTURE.md` + `docs/SYSTEM-ACCEPTANCE.md` + `docs/REQUIREMENTS_REGISTRY.md`, auto-sync stand-down during active workflows (stop.sh + git-auto-pull.sh), TEST single-execution witness with dual independent analysis, per-loop round-limit semantics, `arbitrated_out` logging in all three skills, /spec rerun preservation of /dev-authored §3.2/§3.5–§3.8 (+ non-placeholder §2.13/§2.14), durable `> accepted-at-limit:` doc stamps, canonical ?-less PRD marker (legacy `?` accepted on read), Phase 3.5 mechanical artifact lint, 34 ADR keyword pairs + unfilled-metadata warning, operationalized Update Mode, and progressive disclosure (Phase UT / ADR-NEW / dev §7–§8 bodies → `references/*.md`, section IDs unchanged; `## ADR Template` stays inline). All frozen contracts live in VERSIONING.md "Release checklist (for enforcement repair + loop hardening — 3.9.0+)".
- Grok-dual review backend (3.10.0): `/dev` selects its two evaluators via a runtime-detected `review_backend` (state.json v7, ONE additive field, v6-read defaults to `claude+codex`; window now v3–v7). Detection priority: Agent/Task tool that can launch `subagent_type: claude-auditor` → `claude+codex` (pre-3.10.0 behaviour, contracts verbatim — codex template, xhigh tiering, foreground workaround, dual-claude-degraded fallback); else `spawn_subagent` in the toolset (Grok Build) → `grok-dual`: every review point (plan / doc-audit / diff / test / adversarial) fires TWO parallel native `spawn_subagent` evaluators (`general-purpose` + `capability_mode: "execute"`, `background: false`, same-response spawn per Sync rule 1) — Evaluator A carries the tier-resolved `agents/claude-auditor.md` persona body, Evaluator B additionally the hardened cross-examination charter (blind: never sees A's output). Field names stay FROZEN with positional semantics (`claude_*` = Evaluator A, `codex_*` = Evaluator B under every backend; under grok-dual `codex_available` tracks the second grok evaluator and the codex CLI is irrelevant). grok-dual is FIRST-CLASS (not `degraded`, no Verified cap; backend reported in `/dev status` + the SUMMARY evaluator-results header); its B-failure degradation goes straight to single-evaluator (no dual-claude intermediate), and `codex:codex-rescue` stays claude+codex-only. `/spec` + `/prd` evaluator loops still assume claude+codex (their grok-dual adoption is a future minor). All frozen contracts live in VERSIONING.md "Release checklist (for grok-dual review backend — 3.10.0+)".
- Version-drift visibility (2.12.0+): every `/spec` `/prd` `/dev` invocation runs a Phase 0 banner (`plugins/dev/bin/dev-version-banner.sh <skill> X.Y.Z`, read-only, always exits 0) printing the running dev-template version and warning when a newer plugin was installed mid-session (session↔installed drift — compares the SKILL.md session-bound literal to on-disk `plugin.json`; semver-correct via python3, not `sort -V`). `/spec` + `/prd` stamp every generated doc header with `> dev-template: vX.Y.Z` (filled at write-time from the banner version) and, on rerun, read the anchor doc's stamp (ARCHITECTURE.md for /spec, PRD.md for /prd) to flag artifact drift → pointing at `/spec upgrade-template` or regenerate. The 3 SKILL.md banner literals are sync points (VERSIONING Hard rule 5 → **8 sync points**, not 5). `check-phase.sh` carries one narrow read-only allowance (a `^…$`-anchored regex forbidding shell metacharacters) so the banner runs even on `/dev resume`/`status` into a locked phase. REQUIREMENTS_REGISTRY.md and ADRs are deliberately NOT stamped. All frozen contracts live in VERSIONING.md "Release checklist (for version-drift visibility — 2.12.0+)".

## Test command

There is no automated test suite — this repo is markdown + shell + JSON. Syntax-lint
plus a runtime smoke for the read-only `/dev board` aggregator:

```bash
bash -n plugins/dev/bin/*.sh plugins/dev/skills/dev/bin/*.sh && \
  jq -e . .claude-plugin/marketplace.json plugins/dev/.claude-plugin/plugin.json \
    plugins/dev/hooks/hooks.json > /dev/null && \
  bash plugins/dev/bin/board.sh > /dev/null && \
  bash plugins/dev/bin/dev-version-banner.sh dev 3.10.0 > /dev/null && \
  bash plugins/dev/skills/dev/bin/ledger-parity-check.sh /nonexistent /tmp && \
  T=$(mktemp -d) && printf '{"phase":"plan","repo_root":"%s"}' "$T" > "$T/state.json" && \
  printf '{"tool_name":"Write","tool_input":{"file_path":"/etc/x.md"}}' | \
    CLAUDE_PLUGIN_DATA="$T" bash plugins/dev/skills/dev/bin/check-phase.sh | \
    jq -e '.hookSpecificOutput.permissionDecision == "deny"' > /dev/null && \
  rm -rf "$T"; [ $? -eq 0 ]
```

The board.sh runtime smoke (2.9.0+) catches awk/jq pipeline regressions that
`bash -n` cannot, while remaining side-effect-free (board.sh is read-only by
contract — see `plugins/dev/skills/dev/references/board.md` §7.2). The `bash -n` glob
also covers `skills/dev/bin/check-phase.sh` (the PreToolUse phase gate) and
`skills/dev/bin/ledger-parity-check.sh` (3.8.0 DOCS-exit parity gate), and the
`dev-version-banner.sh` runtime smoke (2.12.0+) exercises the read-only version-drift
banner (also side-effect-free, always exits 0). The `ledger-parity-check.sh` runtime
smoke (3.8.0+) exercises its **fail-OPEN** path: given a nonexistent state file it must
exit 0 (it denies a DOCS transition only on a confirmed §1.5↔§3.4 desync, never on a
parse error). The **check-phase.sh deny-shape smoke (3.9.0+)** feeds a plan-phase Write
through the gate against a temp state file and asserts the decision arrives as
`hookSpecificOutput.permissionDecision == "deny"` — the shape Claude Code actually
honors (a bare top-level `permissionDecision` is zod-stripped and the gate silently
fails open; that was the pre-3.9.0 state). All smokes are read-only / temp-dir-only.

Semantic correctness for skill-markdown changes falls on dual-model evaluator review
(the `/dev` workflow handles this automatically).
