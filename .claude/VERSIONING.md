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

**R5 marker phrases (kept in sync with Phase UT UT.6.1 — 2.3.0 updated)**:

| Section | Marker phrases |
|---|---|
| §2.12 State Management | Owned state surfaces / State transitions / Cross-module state protocol |
| **§2.13 Operations (2.3.0+)** | Health check endpoint / Kill switches / Rollback strategy |
| **§2.14 Observability (2.3.0+)** | Structured logs / Redaction list / SLO target |
| §3.8 Implementation Notes | Alternatives considered / Trade-off |

**Note on §1.1 Serves PRD topics sub-section (2.3.0+)**: intentionally NOT in the R5
marker table. §1.1 body is user-authored module purpose prose (no fixed marker
phrase). Adding Serves PRD topics sub-section to legacy MODULEs is done via `/spec`
main-flow rerun (Phase 2 generation instruction auto-fills from REQUIREMENTS_REGISTRY),
not via `upgrade-template`. See /spec SKILL.md UT.6.1 "Note on §1.1" for the same
explanation at the enforcement site.

When rewording any marker phrase in the template body, update UT.6.1 marker set in
`/spec` SKILL.md Phase UT in the same commit.

## Release checklist (for CONTEXT-MAP / GLOSSARY — 2.4.0+)

When editing the `/spec` Phase 3.3 CONTEXT-MAP generation step, the `/prd` Phase 3.3
GLOSSARY bootstrap, or the `/spec` Phase 2.6 Glossary append step in
`plugins/dev/skills/spec|prd/SKILL.md`, the following must stay in sync (otherwise
/dev's routing and dedup invariants drift):

1. **CONTEXT-MAP regenerates on every `/spec` rerun**: main-flow `/spec` MUST emit
   `docs/CONTEXT-MAP.md` unconditionally, with the same merge-preserve discipline
   `/spec` uses for MODULE docs. Stale detection lives on the `/dev` side (python3
   `os.path.getmtime` over REQUIREMENTS_REGISTRY + modules + PRD + 00-prd + GLOSSARY
   + ARCHITECTURE + IMPLEMENTATION_ORDER + `docs/adr/*.md` (excluding
   `_TEMPLATE.md` and `_INDEX.md`) — **8 upstream sources** as of 2.5.0).
2. **GLOSSARY append-only contract**: entry `**Definition**:` field is immutable
   outside `/prd` Phase 5 GATE Option 5 'Review glossary entries → Edit
   definition'. `/spec §2.6` and future `/dev` writers may only append to
   `**Synonyms**:`, `**Related**:`, and `## Change history`. Enforcement is
   instruction-level (no PreToolUse hook); `/dev` test T39 + T50 grep both SKILL.md
   files for the forbidden-pattern phrase and the Option-5 exception clause.
3. **`normalize()` formula frozen** at the 4 transformations: NFKC + casefold +
   punct-to-space (`-_./\\,`) + whitespace-collapse. Any change to these four is a
   MAJOR `dev` plugin bump (existing GLOSSARY files would de-duplicate differently,
   breaking downstream consumers).
4. **`lev()` implementation frozen** at the stdlib pure-Python DP reference (no
   external Levenshtein dependency). Threshold for the fuzzy-match dedup prompt is
   fixed at `<= 2`.
5. **SSOT for `normalize()` / `lev()` / Add-term protocol**: canonical code and
   pseudocode live in `plugins/dev/skills/prd/SKILL.md §3.3` only. `/spec §2.6`
   cross-references this location by prose path and MUST NOT duplicate the
   implementation. `/dev` test T46 grep-verifies both `(a)` the cross-reference
   phrase presence inside the extracted §2.6 body AND `(b)` that §2.6 contains no
   `def normalize` / `def lev` / `unicodedata.normalize` / `casefold()` /
   `AskUserQuestion:...New term` signatures.

**Anchor-collision invariant for Phase UT**: the UT.4 body-lookup protocol searches for
the exact lines `### 1.2 Architecture Document Structure` and `### 2.2 Unified Module
Document Template` as real headings (outside all code fences). **Do not start any new
line with either of these strings outside a code fence** when editing Phase UT prose,
the canonical YAML, or other sections of SKILL.md. Prose references must either use
backtick-wrapping (e.g., `` `### 2.2 Unified Module Document Template` ``) or mention
the heading inside a fenced code block. Violations create false anchors that silently
break upgrade-template's body lookup for Missing sections.

**ADR-NEW anchor invariant (2.5.0+)**: `/spec adr-new` uses a UT.4-style literal-line
+ fence-tracking protocol to extract the ADR template body. The anchor is the exact
line `## ADR Template` (depth-2, no numeric id — distinct from UT.4's depth-3 numeric
anchors `### 1.2 Architecture Document Structure` / `### 2.2 Unified Module Document
Template`). **Do not start any new line with `## ADR Template` outside a code fence**
anywhere in SKILL.md. Prose references must backtick-wrap (e.g., `` `## ADR Template` ``)
or live inside a fenced code block. Depth-1 (`# ADR Template`) and depth-3 (`### ADR
Template`) variants are NOT equivalent and must not be used as alternative spellings —
the depth-2 form is the single source of truth.

**Nested-fence escape invariant for Phase 1.2 / Phase 2.2 template bodies**: the
outer MODULE/ARCHITECTURE template block is opened with ```` ```markdown ```` and
closed with ```` ``` ```` on its own line. Inner code samples (TypeScript / SQL /
Mermaid) inside the outer template MUST be escaped with a leading backslash (written
as ```` \```typescript ```` / ```` \```sql ```` / ```` \```mermaid ````), otherwise
the outer fence closes prematurely and the UT.4 body-lookup captures a truncated
template. When editing template bodies, verify every inner fence carries the
backslash prefix and the outer fence closes cleanly on the intended line.

## Release checklist (for ADR conventions — 2.5.0+)

When editing the `/spec` Phase 1.0 ADR scan, the `## ADR Template` inline template,
or the `## Phase ADR-NEW` subcommand in `plugins/dev/skills/spec/SKILL.md`, the
following six rules must hold (otherwise downstream ADR sets silently misbehave):

1. **ADR identity scheme frozen**: filenames are `YYYY-MM-DD-{slug}.md` (slug: 1..8
   kebab-case words, total length ≥ 2 chars, `[a-z0-9]` first and last char,
   hyphens in middle only) or `YYYY-MM-DD-{slug}__N.md` where N ∈ 2..99 is a
   same-day collision suffix (double-underscore separator). No `ADR-NNN` numeric
   ID allocator. Heading is just `# {Title}`. Cross-refs by filename only.
   Supersede via `Status: Superseded by {filename}` + `Related > Supersedes:
   {filename}`. Same-day collisions resolved with `__2 / __3 / ... / __99`
   suffixes (the double-underscore separator is frozen to disambiguate from
   semantic slugs ending in digits). Changing this scheme (separator char,
   suffix range, slug grammar) is a MAJOR `dev` bump.

2. **_INDEX.md auto-maintained** by `/spec adr-new` (row append) + `/spec`
   Phase 1.0 step 7 (full rebuild from disk — scans `docs/adr/*.md`, partitions
   by Status into Accepted/Superseded tables, overwrites `_INDEX.md`). Header
   carries `> Auto-maintained by /spec. Do not edit manually.` Hand-edits are
   recoverable via `/spec` rerun but unsupported.

3. **Template lives inline in `/spec` SKILL.md** (`## ADR Template` section).
   Single source of truth; `/spec adr-new` reads it via the UT.4-style
   literal-line + fence-tracking protocol (depth-2 variant). Do NOT add
   `docs/adr/_TEMPLATE.md` to the advance-kit repo root (that path belongs to
   the downstream application project and is gitignored by default).

4. **Related section fixed-label schema**: ADR Template's `## Related` block
   uses exactly the 6 bullets: `PRD topic:`, `REQ-IDs:`, `Modules affected:`,
   `Contracts affected:`, `Supersedes:`, `Complementary:`. Each value is
   single-line comma-separated (or `(none)`). `Modules affected:` uses bare
   `MODULE-NNN` IDs (parser rejects any other format). Phase 1.0 parser relies
   on these exact labels. Missing-label policy: parser treats any missing
   bullet's value as `(none)` (fail-soft). Adding a 7th label OR renaming any
   existing label is a MAJOR `dev` bump. `Complementary:` is populated by
   `/spec` Phase 1.0 conflict-resolution Option C only.

5. **Conflict detection keyword table and decision-marker proximity rule**: the
   set is 22 opposing pairs (see `/spec` SKILL.md Phase 1.0 step 4 for the
   canonical list — that list is the single source of truth for count +
   content; this checklist references it by count, not by redeclaring).
   Removing or renaming any existing pair is a MAJOR bump (existing downstream
   ADR sets would silently re-classify). Adding a new pair is MINOR. The
   decision-marker proximity rule (100-char window around the keyword
   containing one of 32 decision-marker tokens) is **frozen** — tightening or
   relaxing the marker list is a MAJOR bump because existing Accepted ADRs
   would re-fire or stop firing conflicts. Ambiguous English homographs
   (REST-API, ACID-transactions, BASE-semantics, message-queue, message-topic,
   push-based, pull-based, strong-consistency, eventual-consistency,
   at-most-once, at-least-once, exactly-once, optimistic-locking,
   pessimistic-locking) use suffixed forms deliberately; this is also part of
   the frozen contract.

6. **Supersedes chain exemption frozen**: if ADR-A carries `Status: Superseded
   by B` OR `Related > Supersedes: B`, the pair (A, B) is NEVER flagged by
   conflict detection, regardless of keyword overlap. Symmetrically for the
   Complementary exemption (ADR-A `Related > Complementary:` bullet contains
   B). The exemption is direct-link only — transitivity (A supersedes B, B
   supersedes C → exempt (A, C)) is NOT enforced (multi-hop chains are
   expected to be rare, and re-running Phase 1.0 after a supersede re-scans
   with the updated Status).
