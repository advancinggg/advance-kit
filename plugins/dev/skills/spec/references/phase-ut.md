# /spec Phase UT — Section-Level Template Upgrade (reference body)

> Loaded on demand by `plugins/dev/skills/spec/SKILL.md` §0.0 dispatch (3.9.0
> progressive disclosure). Execute with full SKILL.md authority. UT.x section IDs are
> stable reference targets for VERSIONING.md freezes — do not renumber.
> Mentions of "Phase ADR-NEW" resolve to `references/adr-new.md`; the MODULE /
> ARCHITECTURE template anchors that UT.4 scans live in SKILL.md itself (unchanged).


## Phase UT: Section-Level Template Upgrade (resolves Gap 4 — preserves /dev verification progress)

This phase runs **only** when the `upgrade-template` sub-command is dispatched from §0.0.
It performs section-level merge on existing `docs/ARCHITECTURE.md` and
`docs/modules/MODULE-*.md` files so a project can upgrade to the current `/spec`
template without rewriting hand-authored prose and without losing `/dev` verification
progress in §3.4 AC ledgers.

**2.11.0+ also adopts the 2.10.0 system-acceptance layer incrementally** (UT.10): it
injects the `Witness` column into `docs/REQUIREMENTS_REGISTRY.md` and bootstraps
`docs/SYSTEM-ACCEPTANCE.md` — so an existing project gains the system-acceptance axis
**without a full `/spec` rerun**. The section-template upgrade (UT.2–UT.6) regenerates no
content; UT.10 (3.0.0+) runs **evaluator-backed journey discovery** (dual/single/heuristic
tiers — see UT.10.A step 4) to find under-classified REQs + emergent journeys. UT.10 does NOT
regenerate ARCHITECTURE/modules, so a later full `/spec` rerun remains the path for complete
spec re-convergence (PRD coverage, MECE, interface consistency).

Phase UT is independent of the main PRD→spec generation workflow — it does not regenerate
ARCHITECTURE/modules and creates no `progress.json`. (UT.10 step 4 DOES read the PRD
read-only and DOES run evaluator loops for journey discovery, 3.0.0+; the UT.2–UT.6 section
work runs no evaluators.) If a main /spec workflow is active (progress.json exists and is
mid-phase), Phase UT refuses per UT.7.

### UT.1 Target discovery

At entry:
1. If `docs/ARCHITECTURE.md` exists → add to target set, class `arch_sections`.
2. Glob `docs/modules/MODULE-*.md` → add each match to target set, class `module_sections`.
3. Non-MODULE files under `docs/modules/` (e.g., `README.md`) → ignored.
4. If target set is empty → output "No spec docs found in `docs/` — nothing to upgrade" and exit.
5. If only one class is present (arch-only or modules-only) → proceed with that class.
6. **Empty-or-frontmatter-only docs**: after stripping YAML frontmatter (opening `---` to
   closing `---`) and blank lines, if the remainder contains zero heading candidates (per
   UT.5 rule 3), skip the doc with a per-doc notice: "`{path}`: empty / frontmatter-only —
   skipped (nothing to merge; re-run `/spec` to generate from scratch if needed)". The doc
   is NOT rewritten in this case.
7. **Path-confinement check** (guard against symlink / path-traversal attacks in
   collaborative repos). Three independent assertions per target path; any failure
   REFUSES the file and continues with the remaining target set:

   **(a) Regular-file assertion** — the target must be a regular file (not a
   symlink, not a directory, not a device, not a dead link). Docs upgrade is
   restricted to real regular files for simplicity and security; symlinks are
   refused even if they resolve inside `docs/` (eliminates the TOCTOU window
   where cp could follow a symlink to a non-docs target between discovery and
   write, and also catches dangling symlinks that would halt the loop at UT.6
   step 6 `cp`):
   ```bash
   if [ -L "$path" ]; then
     REFUSE "$path: symlink — refused. upgrade-template only accepts regular files under docs/. If this symlink is intentional, replace it with the target file."
   fi
   if [ ! -f "$path" ]; then
     REFUSE "$path: not a regular file — refused (dangling symlink, directory, or special file)."
   fi
   ```

   **(b) Realpath-confinement assertion** — the canonical path (after resolving
   any parent-directory symlinks) must begin with `{repo_root}/docs/` (trailing
   slash enforced to block `docs-evil/` prefix attacks). Canonicalization uses
   python3 (added to §0.1 dependency check); missing python3 → UT entry aborts
   before reaching this step, so python3 is guaranteed present here:
   ```bash
   canon=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$path")
   root_canon=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' \
                  "$(git rev-parse --show-toplevel)")
   case "$canon" in
     "$root_canon/docs/"*) : ok ;;
     *) REFUSE "$path: resolves outside docs/ — refused. (Parent symlink escape detected.)" ;;
   esac
   ```

   **(c) Filename-sanitization assertion** — the relative path (and all
   sub-strings that will be shown to the user in later prompts / warnings) must
   not contain newlines, carriage returns, or control characters (< 0x20
   excluding tab/space, plus DEL). Such characters in filenames enable
   prompt-injection when surfaced in AskUserQuestion / warning text:
   ```bash
   if printf '%s' "$path" | LC_ALL=C tr -d '\t -~' | grep -q '.'; then
     REFUSE "$path: filename contains non-printable / control characters — refused (prompt-injection vector)."
   fi
   ```
   The same sanitization applies at UT.6 step 8 when listing residue filenames:
   any `.spec-upgrade-*.*` file whose name contains control characters is
   listed as `{path_parent}/<filename-redacted-control-chars>` instead of
   echoed verbatim.
8. **Size guard** (DoS prevention): per-doc byte size limit 2 MiB and line-count limit
   20 000. Docs exceeding either threshold emit a confirmation AskUserQuestion: "`{path}`
   is {size}/{lines} — over the 2 MiB / 20 000-line guard. Proceed? (1) Yes, include
   this doc (2) Skip this doc (3) Abort upgrade-template". Default recommendation: (2).
9. **System-acceptance migration targets (2.11.0+)** — separate from the section-merge
   pipeline (UT.2–UT.6 process ARCHITECTURE + MODULE docs only). Record two extra paths
   for UT.10:
   - `docs/REQUIREMENTS_REGISTRY.md` — the **precondition** for UT.10. Absent → UT.10
     is skipped entirely (a lightweight project with no registry has nothing to migrate;
     it already behaves as pre-2.10.0). Present → class `registry`.
   - `docs/SYSTEM-ACCEPTANCE.md` — if present, class `system_acceptance` (UT.10 will
     merge-preserve its §2 `passed` SYS-AC rows); if absent, UT.10 may create it.
   Both paths get the SAME path-confinement checks as steps 7(a)/(b)/(c) — regular-file
   (refuse symlinks), realpath under `{repo_root}/docs/`, and filename sanitization — and
   the create target (`docs/SYSTEM-ACCEPTANCE.md`) additionally requires `docs/` itself to
   be a real directory whose realpath is under `{repo_root}` before any write (same guard
   as `/spec adr-new`). The registry is NOT passed through the UT.2–UT.6 section parser
   (it is a table-column edit, not a §-section merge).

### UT.2 Canonical section list (kept in sync with the live templates)

Source of truth: the fenced ```markdown blocks inside Phase 1.2 and Phase 2.2 of
THIS file (search for headings `### 1.2 Architecture Document Structure` and
`### 2.2 Unified Module Document Template`). This canonical list and the live
template blocks must be edited together in one commit (see VERSIONING.md release
checklist).

```yaml
module_sections:
  part_markers:  # depth-2 structural dividers; ensured in order
    - { id: "PART-1", anchor_prefix: "## Part 1: ", canonical_title: "Requirements",   position: "before §1.1" }
    - { id: "PART-2", anchor_prefix: "## Part 2: ", canonical_title: "Specification",  position: "before §2.1" }
    - { id: "PART-3", anchor_prefix: "## Part 3: ", canonical_title: "Implementation", position: "before §3.1" }
  sections:  # depth-3 (all `### N.M`)
    - { id: "1.1", title: "Module Goals & Overview",                depth: 3 }
    - { id: "1.2", title: "Architecture Overview",                  depth: 3 }
    - { id: "1.3", title: "Feature Matrix",                         depth: 3 }
    - { id: "1.4", title: "Detailed Feature Specifications",        depth: 3 }
    - { id: "1.5", title: "Acceptance Criteria",                    depth: 3 }
    - { id: "1.6", title: "Non-functional Requirements",            depth: 3 }
    - { id: "1.7", title: "Security Requirements",                  depth: 3 }
    - { id: "2.1", title: "Module Boundary",                        depth: 3 }
    - { id: "2.2", title: "Dependencies",                           depth: 3 }
    - { id: "2.3", title: "Interface Definitions",                  depth: 3 }
    - { id: "2.4", title: "API Endpoints",                          depth: 3 }
    - { id: "2.5", title: "Data Models",                            depth: 3 }
    - { id: "2.6", title: "Database Functions & RPCs",              depth: 3 }
    - { id: "2.7", title: "Core Logic",                             depth: 3 }
    - { id: "2.8", title: "Error Handling",                         depth: 3 }
    - { id: "2.9", title: "Security Considerations",                depth: 3 }
    - { id: "2.10", title: "Configuration & Environment Variables", depth: 3 }
    - { id: "2.11", title: "Operational Parameters",                depth: 3 }
    - { id: "2.12", title: "State Management",                      depth: 3 }
    - { id: "2.13", title: "Operations",                            depth: 3 }
    - { id: "2.14", title: "Observability",                         depth: 3 }
    - { id: "3.1", title: "Current Status",                         depth: 3 }
    - { id: "3.2", title: "File Structure",                         depth: 3 }
    - { id: "3.3", title: "Test Cases",                             depth: 3 }
    - { id: "3.4", title: "Acceptance Criteria Verification",       depth: 3 }
    - { id: "3.5", title: "Feature Implementation Record",          depth: 3 }
    - { id: "3.6", title: "Known Gaps & Future Work",               depth: 3 }
    - { id: "3.7", title: "Change History",                         depth: 3 }
    - { id: "3.8", title: "Implementation Notes",                   depth: 3 }

arch_sections:
  - { id: "1",    title: "Architecture Overview",                   depth: 2 }
  - { id: "2",    title: "Technology Stack",                        depth: 2 }
  - { id: "3",    title: "Module Inventory",                        depth: 2 }
  - { id: "3.1",  title: "MECE Verification",                       depth: 3 }
  - { id: "4",    title: "Dependency Graph",                        depth: 2 }
  - { id: "4.1",  title: "Dependency Matrix",                       depth: 3 }
  - { id: "4.2",  title: "Dependency Principles",                   depth: 3 }
  - { id: "5",    title: "Data Flow",                               depth: 2 }
  - { id: "6",    title: "Interface Definitions",                   depth: 2 }
  - { id: "6.1",  title: "Inter-module Contract Registry",          depth: 3 }
  - { id: "6.2",  title: "External Interfaces",                     depth: 3 }
  - { id: "7",    title: "Non-functional Requirements Mapping",     depth: 2 }
  - { id: "8",    title: "Key Decision Records",                    depth: 2 }
  - { id: "9",    title: "Risk Register",                           depth: 2 }
  - { id: "10",   title: "Requirement Traceability",                depth: 2 }
  - { id: "11",   title: "Threat Model",                            depth: 2 }
  - { id: "11.1", title: "Attack Surfaces",                         depth: 3 }
  - { id: "11.2", title: "STRIDE Analysis (for modules handling auth/payment/PII)", depth: 3 }
  - { id: "11.3", title: "Security Control Decisions",              depth: 3 }
```

### UT.3 Section classification (per target doc)

#### UT.3.0 Identity resolution (title-primary — 3.3.0+ renumber-preserve)

A section's identity is its **title**, not its number — so a section that MOVED (because a new
section was inserted earlier in the template, shifting every later number) is recognised as the
same section, not overwritten. Resolve each existing section's true canonical id BEFORE classifying:

1. Build `canonical_title → id` from the UT.2 canonical list (titles are unique within a doc class).
2. For each existing doc section parsed as `### N.M  <Title>` (or `## N.`):
   - **`<Title>` matches exactly one canonical id M** → the section's true id is **M**:
     - `N == M` → ordinary **Kept**.
     - `N != M` → **Kept (renumber-preserve)** — the section moved N→M (an inserted section
       shifted it). Preserve **body AND title verbatim**; change ONLY the number to M; never
       retitle (that retitle is exactly the corruption this fixes). Cascade per step 3.
   - **`<Title>` matches NO canonical id** → fall back to number: `N` is a canonical id → genuine
     **retitle** (the canonical title for `N` was reworded) → ordinary Kept (rewrite heading to
     current title); `N` not canonical → **Orphan** (UT.3.3). This zero-title-match case is the
     fallback — it is NOT routed to the step-4 guard.
   - **Two sections share the same `<Title>`** → ordinary **Duplicate** → UT.3.3 (unchanged); the
     step-4 guard handles only renumber *collisions*, never ordinary duplicates.
3. **Build the full renumber map first, then apply it ATOMICALLY.** Collect every
   renumber-preserve `N.M → N'.M'` into ONE map and apply ALL substitutions in a SINGLE pass
   computed from the ORIGINAL text (or via unique sentinels) — NEVER sequentially, else a chain
   like `§1.2→§1.3` + `§1.3→§1.4` would compound (`§1.2` refs wrongly become `§1.4`). Per
   renumbered id, two substitutions:
   - the section's own depth-4 child headings: match ONLY real heading lines
     `^#### N\.M\.K\b` (anchored to the exact `N.M` id segment + a numeric child `.K`), so
     `#### 1.2.3` is rewritten but `#### 1.20.x` and a prose `1.2.3` are NOT → `#### N'.M'.K`;
   - inline cross-references `§N.M` → `§N'.M'`, word-boundary anchored (`§N\.M\b`, so `§1.2` never
     matches `§1.20`) and **only OUTSIDE code fences** (reuse the UT.5 rule-1 fence tracker — never
     rewrite a literal `§1.2` inside a fenced example).
   Record every renumber + cascade edit in the UT.9 summary.
4. **Ambiguity guard (no silent reorder — same discipline as UT.3.1)**: do NOT auto-apply when the
   renumber map is ambiguous — specifically: a `<Title>` matches MULTIPLE canonical ids; a renumber
   **target** id is already claimed by another Kept/renumbered section (collision); or the map has a
   cycle (A→B and B→A / swap). (Ordinary Duplicate and zero-title-match are NOT ambiguity — they
   follow step 2.) On ambiguity, per-doc AskUserQuestion: "Section renumbering in `{path}` is
   ambiguous ({observed → proposed map}). (1) Apply the proposed renumber map (2) Keep numbers
   as-is + annotate (3) Skip this doc." A clean, unambiguous map defaults to (1); ambiguous → NO default.
5. **§3.4 interaction**: the UT.8 §3.4 special-cases (passed-AC merge-preserve + placeholder-strip)
   follow the *Acceptance Criteria Verification* section by its **resolved canonical id**
   (post-renumber), NOT the raw observed number — a renumbered §3.4 keeps its `Active=Y,
   Status=passed` rows because renumber-preserve copies the body verbatim.

Then classify, using the **resolved** ids from UT.3.0 (`for every id in the canonical list and in
the existing doc`):

| Class        | In template | In doc | Action |
|--------------|-------------|--------|--------|
| **Kept**     | ✓           | ✓ (1×) | Preserve body verbatim. Rewrite heading line to current title + correct depth marker (`## N.` for depth 2, `### N.M` for depth 3). |
| **Kept (renumber-preserve, 3.3.0+)** | ✓ | ✓ (title matches a DIFFERENT id) | Preserve body **and title** verbatim; change only the number to the resolved canonical id; cascade per UT.3.0 step 3. NEVER retitle. |
| **Missing**  | ✓           | ✗      | Insert heading at correct depth (from canonical `depth` field), followed by boilerplate body (UT.4). Position per UT.3.2. |
| **Orphan**   | ✗           | ✓      | Batched AskUserQuestion (UT.3.3). Default: Keep + Annotate. |
| **Duplicate**| ✓           | ✓ (≥2) | Batched AskUserQuestion (UT.3.3). Default: Concatenate bodies in source order. |

#### UT.3.1 Part-marker identity rule (MODULE only)

After classification, enforce: exactly three `## Part N:` markers in order,
immediately before §1.1 / §2.1 / §3.1.

- **All three present, correct titles, correct positions** → no-op.
- **Missing one or more** → insert per canonical list position.
- **Duplicated** → keep first occurrence of each id, drop the rest.
- **Out-of-order** (Part 2 appears before Part 1) → do NOT silently reposition (structural
  rewrite without consent is a surprise vector). Emit per-doc AskUserQuestion: "Part
  markers in `{path}` are out-of-order ({observed sequence}). Choose: (1) Reposition each
  marker to immediately precede its canonical first section (2) Keep the current order
  and continue — user intended this structure (3) Skip this doc." Default: (1).
- **Non-canonical title** (e.g., `## Part 1: Introduction` instead of `## Part 1:
  Requirements`) → per-doc AskUserQuestion: (1) rewrite to canonical title
  (2) keep as-is + annotate with HTML comment (3) treat as Orphan (UT.3.3 flow)
  (4) skip this doc.
- **Extra Part 4+** → route to UT.3.3 Orphan handling.

#### UT.3.2 Missing-section insertion position

Insert after the last Kept section with a **smaller id**, before the first Kept
section with a **larger id**. Order is lexicographic over the split-digit tuple:
`(1,) < (1,1) < (1,2) < (1,10) < (2,) < (2,1)`.

If the target doc has zero Kept sections in the relevant Part (e.g., Part 3
entirely new), insert the Part marker first, then all Missing §3.x in order.

#### UT.3.3 Batched AskUserQuestion for Orphan / Duplicate / non-canonical Part titles

**Orphan-count cap (DoS-resistance)**: if a single doc has more than 20 Orphan + Duplicate
sections combined, do NOT enumerate them per-section. Emit a 3-way summary-only prompt:
"`{path}` has {N} Orphan + {M} Duplicate sections — over the 20-count detail cap. Choose:
(1) Keep all with a single top-of-doc HTML-comment summary listing counts only — not
per-section annotation (2) Remove all orphans; keep first of each duplicate (3) Skip
this doc." Below 20, use the enumerated prompt below.

Per-doc single prompt (≤20 non-canonical sections):

```
docs/modules/MODULE-001-foo.md has the following non-canonical sections:

Orphan (3):
  - §4.1 "Custom Integration Notes" (12 lines)
  - §5.0 "Legacy Debug Hooks" (30 lines)
  - §3.9 "Rollout Plan" (8 lines)

Duplicate (1):
  - §2.5 appears twice (approx lines 140 and 210; sizes 45 / 5 lines)

Non-canonical Part title (1):
  - ## Part 1: Introduction (canonical: Requirements)

Choose default action for ALL above (single selection):
  (1) Keep + Annotate orphans; Concatenate duplicates; normalize Part titles  [recommended]
  (2) Remove orphans; Keep first duplicate; normalize Part titles
  (3) Per-section decisions (opens up to 10 follow-up questions; excess → (1))
  (4) Abort upgrade of this doc
```

**Follow-up cap (option 3)**: limit to 10 AskUserQuestions per doc. Once exceeded,
apply default-action (1) to all remaining sections. Emit end-of-doc summary:
"Auto-applied default-action to X sections due to follow-up cap (all sections
fully resolved — no leftover state)."

### UT.4 Missing-section boilerplate (body lookup)

Resolution protocol (runs once at Phase UT entry):

1. Resolve THIS skill's SKILL.md via the same Tier 1/2/3 protocol Phase ADR-NEW uses
   (3.9.0 — the old hardcoded `plugins/dev/skills/spec/SKILL.md` repo-relative path only
   exists in the plugin-development repo, NOT in downstream installed-plugin projects):
   **Tier 1**: `$CLAUDE_PLUGIN_ROOT/skills/spec/SKILL.md`; **Tier 2**: the installed
   plugin cache copy (see Phase ADR-NEW's Tier 2 for the cache path + ownership check);
   **Tier 3**: `plugins/dev/skills/spec/SKILL.md` (repo-relative — plugin-development
   repos only). Verify the chosen file contains both anchor headings from steps 3–4
   below (fence-aware); on failure fall through to the next tier; all tiers failing →
   abort Phase UT with an explicit error (NEVER reconstruct template bodies from memory).
2. Track code fences (UT.5 rule 1) while scanning. **Anchor headings match only
   when they are real `###` heading lines OUTSIDE all code fences.** The UT.2
   canonical list YAML block (inside a ```yaml fence) does NOT match.
3. Find the exact line matching `^### 1\.2 Architecture Document Structure$`
   (outside fences). Within its body, locate the next ```markdown fence open and
   capture until the matching close.
4. Find the exact line matching `^### 2\.2 Unified Module Document Template$`
   (outside fences). Same capture.
5. Inside each captured block, split on canonical section headings; each heading's
   body is text between it and the next canonical heading (or Part marker).
6. Cache in-memory for the duration of the upgrade-template run.

Template-body edits (adding a table column, rewording a placeholder) propagate
automatically via this lookup.

### UT.5 Parser spec

**Input normalization (applied before parsing)**:

- **BOM**: if the first bytes of the file are `EF BB BF` (UTF-8 BOM `U+FEFF`), strip
  them. Without this, the first line's `^` anchor match fails and the frontmatter
  opener `---` is missed.
- **Line endings**: normalize `\r\n` (CRLF) and lone `\r` (CR) to `\n` (LF) before
  parsing. Docs authored on Windows or mixed-line-ending environments must not cause
  regex anchors to silently fail.
- **Trailing whitespace** on heading lines is tolerated by the regex (lazy title match
  + `\s*$`).

Output-write normalization is **mandatory and deterministic** (not implementation
choice, to avoid spurious git diffs from line-ending flips): always write LF-only with
NO BOM. If the input had CRLF or BOM, record a per-doc notice in the UT.9 summary:
"`{path}`: normalized from CRLF/BOM to LF. Review your editor settings to avoid
re-introducing." This one-time switch is intentional — preserving idiosyncratic
line-ending mixes would produce unreadable diffs on every future /dev / /spec run.

The section-heading parser MUST:

1. **Fence tracking (CommonMark-aligned)**:
   - A fence open is a line that **starts at column 0** with **three OR MORE**
     consecutive backticks or tildes (markdown allows 4+ backticks to fence
     blocks that themselves contain 3-backtick sequences). Lines prefixed with
     `\` (backslash-escaped forms used as inline illustrations in prose) are
     NOT fences.
   - A fence close is a line containing ONLY backticks/tildes (same char as
     opener), of length **≥ opener length**, with optional trailing whitespace
     (per CommonMark §4.5). An opener with 3 backticks is closed by 3, 4, 5,
     ... backticks; an opener with 4 backticks is closed by 4+. State machine
     tracks the opener char and length.
   - State machine: outside → seeing `\`\`\`+lang` (or `~~~+lang`) on its own
     line at column 0 → inside-fence with {char, length} recorded → seeing a
     line of ≥length of the same char (and only that char + trailing whitespace)
     → outside.
   - Heading-candidate lines inside a fence are non-heading content.
2. Skip YAML frontmatter (`---` open/close at start of file).
3. Heading recognition (outside fences) — match on:
   ```
   ^(#{2,3}) +(\d+(?:\.\d+)?)\.? +(.+?)\s*$
   ```
   - Group 1 = depth marker (`##` or `###`)
   - Group 2 = numeric id with at most one dot (`1`, `3.1`, `11.3`). Canonical
     lists use 1 or 2 segments only; multi-segment ids (`1.4.1`) are rejected by
     this regex and treated as body content.
   - `\.?` = OPTIONAL trailing period (ARCHITECTURE depth-2 `## N.`; MODULE
     depth-3 `### N.M` without period).
   - Group 3 = title (lazy match, trailing whitespace stripped).
4. Part markers recognized separately: `^## Part (\d+): +(.+?)\s*$`. Title
   compared to canonical; mismatch → UT.3.3 flow.
5. Reject `####` and deeper — depth-4+ headings are body content.
6. Reject ids with leading zeros (`01`, `01.2`) — canonical list has no
   zero-padded ids. Post-regex check: after successful match of Group-2 id,
   verify the first character is not `'0'` (the regex itself allows leading
   zeros because `\d+` accepts them). Reject with treat-as-body-content
   semantics: the line is not classified as a heading and flows into the
   preceding section's body.

### UT.6 Write protocol

One Write call per doc (full replacement), but **atomic at the filesystem level** via
tmp-file + rename. Pre-write flow:

1. Per-doc dry-run summary (printed):
   ```
   docs/modules/MODULE-001-foo.md:
     Kept: 18 sections (bodies preserved)
     Missing: 2 sections — will insert: 2.12, 3.8
     Orphan: 0
     Duplicate: 0
     Part markers: 3/3 present
     Legacy-body flags: 0
   ```
2. Cross-doc summary table.
3. Single AskUserQuestion: "Apply upgrades to N docs? (1) Yes, all (2) Review each
   doc's diff (3) Abort".
4. If "review each": show full diff per doc via Bash `git diff --no-index` against
   a temp file; AskUserQuestion per doc.
5. **Pre-write §3.4 row snapshot** (for the count check in step 7): for each doc,
   record `pre_passed_count` = number of §3.4 rows matching `Active=Y` AND
   `Status=passed` — compute BEFORE writing.
6. **Atomic write per doc using unpredictable tmp names** (defends against
   pre-placed companion-path symlink attacks): generate tmp and backup paths via
   `mktemp` inside the same directory as the target doc, NOT using deterministic
   `{path}.upgrade-tmp` / `{path}.backup` suffixes (deterministic names let a
   collaborator commit a symlink at that exact path and redirect the upgrade write
   to an arbitrary file). Concretely:
   ```bash
   dir=$(dirname "$path")
   tmp=$(mktemp "$dir/.spec-upgrade-tmp.XXXXXX") || exit 1
   backup=$(mktemp "$dir/.spec-upgrade-backup.XXXXXX") || exit 1
   ```
   Order: (a) `cp -pP "$path" "$backup"` — `-p` preserves mode/timestamps.
   Note on `-P` portability: GNU cp honors `-P` even without `-R` and will NOT
   follow symlinks on the source; BSD cp (macOS) documents `-P` as "ignored
   unless the -R option is specified" (non-recursive cp follows symlinks
   regardless). Because UT.1 rule 7(a) already rejects symlinks upstream,
   `$path` at this point is guaranteed a regular file; `-P` is defense-in-depth
   on GNU and a no-op on BSD. The authoritative symlink guard is UT.1 rule
   7(a), not cp's flag. If cp fails, REFUSE the doc. mktemp-generated
   companions have unpredictable suffixes, so they are not attacker-controllable.
   (b) Write the new content to `$tmp` — and ensure the doc header's quote-block carries
   `> dev-template: v{Phase-0 banner version}` (add the line if absent, refresh if stale; 3.6.1+,
   closes the gap where section-level upgrades previously left ARCHITECTURE/MODULE docs unstamped).
   (c) Verify `$tmp` has non-zero size. (d)
   `mv "$tmp" "$path"` via Bash `mv`. If any step fails, `$path` may be clobbered
   by (d) — the `$backup` is the recovery source (step 7-revert).
7. **Post-write pass-count verification** (defends `Active=Y, Status=passed` count
   deltas — NOT content-level mutations; a Claude hallucination that edits a row's
   `Verified By Task` or `Date` column while keeping pass-count constant is OUT OF
   SCOPE of this check and must be caught by the user-review diff in step 4):
   recompute `post_passed_count`. If `post_passed_count != pre_passed_count`,
   REVERT via `mv "$backup" "$path"` and REFUSE with:
   "`{path}`: post-write §3.4 pass-count verification failed ({pre_passed_count} →
   {post_passed_count} passed rows). The §3.4 ledger row count changed during
   upgrade — a Claude copy hallucination likely dropped or duplicated passed rows.
   Original restored from backup. Re-run `/spec upgrade-template` and review the
   diff carefully, including non-count row content changes which this check does
   NOT detect."
8. **Backup cleanup protocol**: on step-7 PASS → `rm "$backup"` immediately.
   On step-7 FAIL → the revert in step 7 consumes `$backup` (`mv` moves it back to
   `$path`). On ANY interrupt/crash path that skips steps 7-8 → the `$backup` file
   remains on disk but its name begins with `.spec-upgrade-backup.` (hidden,
   unpredictable suffix). Phase UT entry SHOULD sweep `docs/` for pre-existing
   `.spec-upgrade-backup.*` / `.spec-upgrade-tmp.*` residue and, if found, emit a
   warning: "Previous upgrade-template run left residue: {list}. Review and
   `rm` manually before proceeding." The final UT.9 summary MUST also list any
   residue not cleaned up. Recommended project `.gitignore` entry (surface in
   UT.9):
   ```
   docs/**/.spec-upgrade-tmp.*
   docs/**/.spec-upgrade-backup.*
   ```
9. Error in any step → halt loop; completed docs remain upgraded; surface error.

#### UT.6.1 R5 legacy-body collision check

For each **Kept** section, apply a deterministic placeholder-marker check:

- **Marker set §2.12 State Management**: `"Owned state surfaces"`,
  `"State transitions"`, `"Cross-module state protocol"` (short prose phrases
  appearing in the live template body).
- **Marker set §2.13 Operations** (2.3.0+): `"Health check endpoint"`,
  `"Kill switches"`, `"Rollback strategy"` (section subheadings / table
  keywords in the live template body).
- **Marker set §2.14 Observability** (2.3.0+): `"Structured logs"`,
  `"Redaction list"`, `"SLO target"`.
- **Marker set §3.8 Implementation Notes**: `"Alternatives considered"` and
  `"Trade-off"` (two short independent phrases; appear in the template's table
  header).

**Note on §1.1 Serves PRD topics (2.3.0+)**: intentionally NOT included in the R5
marker set. §1.1 body is user-authored module purpose prose with no fixed marker
phrase — adding markers would false-positive every pre-2.3.0 MODULE doc as legacy-
body collision. The new "Serves PRD topics" sub-section propagates to legacy MODULE
docs via `/spec` main-flow rerun (Phase 2 auto-fills from REQUIREMENTS_REGISTRY), not
via `upgrade-template`.

Before substring matching, normalize both the existing body and the marker by
collapsing runs of whitespace (including tabs) to single spaces.

Per Kept section whose marker set is non-empty: if the existing body contains
ZERO of the marker phrases (after normalization) → flag as "legacy-body
collision" (likely pre-2.1.0 user content at this id). Emit per-doc
AskUserQuestion:

```
§2.12 in MODULE-003 is Kept but its body contains none of the canonical template
landmark phrases ({phrase list}). Likely pre-2.1.0 user-authored content. Choose:
  (1) Preserve body as-is (assume legacy user intent)
  (2) Renumber user content to next-free id (§2.13 / §3.9) and insert fresh
      template body at §2.12
  (3) Skip this doc
```

### UT.7 Active-workflow hard gate

If `docs/.spec-state/progress.json` exists AND its `phase` field is in
`{"architecture", "modules", "implementation_order"}`, **REFUSE** with error:

> Active /spec workflow in phase {phase}. Run `/spec abort` before
> `upgrade-template`, then re-run `/spec` after upgrade completes if needed.

If phase is `"init"` or `"report"` (no active mid-flow state), silently allow.

### UT.8 §3.4 AC ledger preservation (the Gap 4 core promise)

**Trust boundary — upgrade-template preserves; it does NOT verify.** The §3.4 rows
present in the existing doc are carried forward verbatim. If a collaborator or
attacker committed forged `Status=passed` rows via direct edit, upgrade-template will
preserve them unchanged — `upgrade-template` is not a verifier. Provenance of §3.4
rows is guaranteed by the /dev SUMMARY commit trailer (`AC: {id}`) + git history +
/spec Evaluator loops, NOT by upgrade-template. This is intentional: upgrade-template
is a mechanical merge tool, not an AC authority. Users reviewing a pre-upgrade diff
should run `git log --all --source -- docs/modules/MODULE-XXX.md` to verify the
provenance of suspicious `Status=passed` rows.

Because Missing→Insert only applies to §3.4 when §3.4 is actually Missing,
merge-preserve holds:

- §3.4 already present with `Active=Y, Status=passed` rows → Kept verbatim;
  /dev verification progress preserved. **This is the primary Gap 4 path.**
- §3.4 absent (very old template) → fresh template boilerplate inserted. Note:
  the live §3.4 template body contains **placeholder example rows** (e.g.,
  `MODULE-001-AC-01 | Y | untested`) illustrating the schema; these are
  sample content, not real AC IDs. Special-case handling for §3.4 Missing:
  strip the placeholder rows from the boilerplate before insert, leaving only
  the table header + column descriptions. The next ordinary `/spec` rerun
  then populates real AC IDs from §1.5 via the merge-preserve rules in the
  live §3.4 Generation block (search heading `### 3.4 Acceptance Criteria
  Verification` in SKILL.md for those rules). Without this special case,
  upgrade-template would leave cross-module-polluting sample rows in the
  upgraded doc (e.g., `MODULE-001-AC-01` references inside MODULE-003-auth.md).

This is the critical difference from "Regenerate all" (option 1 of the §0.2
gate): Regenerate discards §3.4 body entirely; merge-preserve then re-derives
rows from §1.5 but cannot recover `Status=passed` history because the source
was already overwritten. `upgrade-template` preserves existing history and,
for the Missing case, leaves a clean ledger ready for the next /spec rerun to
populate accurately.

### UT.8.1 Iron Rule scope & R5 hint-semantics (threat-model clarifications)

**Iron Rule applies to skill-emitted output only — not to user document bodies that
upgrade-template preserves verbatim.** Suppose a pre-existing MODULE doc has a
user-authored Orphan section with a heading that would itself trip the Iron Rule
grep (e.g., a legacy planning note). That is user content, not skill output, and
upgrade-template preserves it unchanged. The HTML annotation comment that UT.3
emits alongside the preserved body (`<!-- retained by /spec upgrade-template:
section not in current template vX.Y.Z -->`) IS skill output and MUST remain free
of Iron-Rule-forbidden phrases. Users who want to eliminate such prose in their
own docs should edit those docs directly — upgrade-template does not sanitize user
content.

**R5 marker-phrase check (UT.6.1) is a hint, not a gate.** The fixed marker set is
trivially spoofable (attacker can paste `"Owned state surfaces"` into an unrelated
§2.12 body; genuine user can reword "Owned" → "Managed" and trigger a false flag).
The check exists to catch the common case of pre-2.1.0 hand-authored §2.12 that
clearly never touched the new template — not to be a security boundary. When in
doubt, users should inspect the dry-run diff (UT.6 step 3/4) rather than rely on R5
classification.

**Self-reference poisoning (tampered SKILL.md after plugin install) is an accepted
constraint.** upgrade-template reads the body-lookup source from the installed skill
file with no hash or signature check. A malicious post-install modification of
SKILL.md will poison future upgrades — but a malicious SKILL.md is a broader problem
than upgrade-template (the entire /spec and /dev surface is compromised). Plugin
integrity is a marketplace-level concern, not a per-subcommand defense.

### UT.10 System-acceptance layer migration (2.11.0+; 3.0.0+ evaluator-backed journey discovery)

Brings the 2.10.0 system-acceptance layer into an existing project **without a full
`/spec` rerun**. Runs after the UT.6 section-merge writes complete, under the UT.7
active-workflow gate; its results feed the UT.9 summary. **Skipped entirely** when
`docs/REQUIREMENTS_REGISTRY.md` is absent (UT.1 step 9 — a lightweight project already
behaves as pre-2.10.0). Idempotent and merge-preserving on re-run.

**Scope contract (3.0.0+)**: UT.10 runs **evaluator-backed journey discovery** — the same
dual-evaluator method as Phase 1.3 (Claude auditor + Codex, loop-until-dry), degrading to
single-evaluator (Codex absent) or to a legacy heuristic (no evaluator available at all). It
discovers under-classified REQs and emergent cross-module journeys; it is NOT merely a grep.
What UT.10 still does NOT do: regenerate ARCHITECTURE.md / MODULE docs or re-run their
evaluator loops — so a full `/spec` rerun remains the path for complete spec re-convergence
(PRD coverage, MECE, interface consistency). UT.10 and a full rerun are complementary, not
redundant: UT.10 = template-structure upgrade + /dev progress preservation + evaluator-grade
journey discovery; a full rerun additionally regenerates ARCHITECTURE/modules. The UT.9
summary states which evaluator tier ran. Authorship partition is preserved: UT.10 never writes
a SYS-AC `passed` (that stays /dev SUMMARY's), and e2e marking still requires the explicit
UT.10.A policy prompt (step 5).

#### UT.10.A — Witness column injection (`docs/REQUIREMENTS_REGISTRY.md`)

1. **Idempotency (mechanical column insert only)**: if the In-Scope Requirements table header
   already contains a `Witness` column → the column insert is already done; SKIP steps 2–3 and
   go straight to **step 4 discovery**. Discovery (step 4) + policy (step 5) STILL run — they are
   NOT idempotent-skippable: new REQs or newly-recognized emergent journeys may have appeared
   since the last migration, so existing 2.11/2.12 projects DO get evaluator discovery on re-run
   (step 5 finds no candidates → no prompt → no change when nothing is new, so re-runs stay safe +
   additive). If the column is absent → run steps 2–3, then 4–5.
2. **Header precondition (fail-safe for drifted legacy registries)**: the In-Scope table
   header MUST contain BOTH a `Type` and a `Module(s)` column. If either is missing (a
   hand-edited / pre-2.10.0 header whose columns drifted), REFUSE the Witness injection with
   the notice — "REQUIREMENTS_REGISTRY In-Scope header is missing the `Type` and/or
   `Module(s)` column; Witness injection skipped to avoid misaligning the table. Normalize
   the header (or run a full `/spec` rerun) and re-run upgrade-template." — then skip to
   UT.10.B (which finds no `Witness` column → no e2e REQs → writes the skeleton). This never
   corrupts a malformed table; it degrades safely.
3. Else inject `Witness` between `Type` and `Module(s)` (the canonical §0.4.1 position).
   Every existing data row (Active=Y AND Active=N) defaults to **`unit`** — the safe
   default that creates no e2e obligation, so the /dev System Acceptance gate stays
   dormant. The separator row gains a matching `---` cell. ALL other columns / cells /
   rows are preserved verbatim (a mechanical column insert, NOT a regeneration).
4. **e2e-candidate + journey discovery (3.0.0+, evaluator-backed; tiered)**. Discover which
   REQs are system-behaviour and what journeys exist, using the best available tier (read the
   `codex_available` flag + auditor presence from the Phase 0.1 dependency check):

   - **Tier 1 — dual-evaluator (default; Claude auditor + Codex both available).** Spawn TWO
     fresh independent evaluators in the SAME assistant response (Dual-Evaluator Sync Protocol
     rule 1), ZERO prior-classification knowledge. Inputs: the just-migrated
     `REQUIREMENTS_REGISTRY.md` (Witness column all `unit`), `docs/PRD.md` / `docs/00-prd/*.md`
     (confined per UT.1 step 7), and read-only `docs/ARCHITECTURE.md` / `docs/modules/*.md` /
     `docs/SYSTEM-ACCEPTANCE.md` if present. Prompt (both): "Discover system-acceptance
     journeys for this EXISTING project. (a) Flag [Critical] every REQ that is genuinely
     system-behaviour — cross-module + user-observable end-to-end (PRD §3 flows flagged
     'System acceptance journey', or behaviour spanning ≥2 modules) — currently marked
     Witness:unit/integration (under-classification). (b) Discover EMERGENT journeys: a
     cross-module user-observable behaviour that NO single REQ captures (arises from a chain
     of REQs/modules); list each as: short name — REQ-IDs spanned — module chain. Output:
     `Under-classified REQs:`, `Emergent journeys:`, `Substantive Findings: N`,
     `Verdict: PASS|FAIL`." Codex runs foreground `codex exec -s read-only` (timeout 600000),
     per the Phase 1.3 Codex command template. **loop-until-dry**: re-spawn fresh evaluators
     each round; stop when a round surfaces NO new under-classified REQ AND NO new emergent
     journey (cap 5 rounds → take the union so far, note in UT.9). Merge both evaluators by
     UNION; a one-evaluator-only finding is arbitrated toward INCLUSION (completion, never
     pruning — this is the anti-"silently-drop-journey" rule).
   - **Tier 2 — single-evaluator (Codex unavailable per dep check).** Same prompt, Claude
     auditor only; loop-until-dry as above.
   - **Tier 3 — heuristic fallback (no auditor available at all).** Legacy rule, no evaluator:
     a REQ is a candidate if its `Module(s)` cell names ≥2 distinct `MODULE-NNN` IDs, OR its
     Source/Section maps to a PRD §3 flow flagged `System acceptance journey: Yes` — when
     matching that marker, accept BOTH the canonical ?-less spelling AND the legacy
     `System acceptance journey?` form emitted by 3.5.0–3.8.0 /prd templates (3.9.0:
     a literal grep for only one spelling silently drops every PRD-flagged journey of the
     other era — the exact failure this layer exists to prevent). No
     emergent-journey discovery.

   The **candidate REQ set** = under-classified REQs (Tier 1/2) ∪ the REQs named in discovered
   emergent journeys, or the grep matches (Tier 3). Discovered emergent-journey groupings feed
   UT.10.B seeding. Record the tier + round count + counts (under-classified REQs / emergent
   journeys) for the UT.9 summary.
5. Print the candidate REQ list (`REQ-ID — Description — reason flagged`) AND the discovered
   emergent journeys (`name — REQ-IDs — module chain`), then ONE **policy** AskUserQuestion
   (respects the 2–4 option cap — do NOT attempt a per-REQ multi-select, which can exceed it):
   - (1) Mark the listed {N} candidates as `Witness:e2e` (recommended)
   - (2) Keep all `unit` — I'll mark e2e by hand later
   - (3) Abort migration (registry left untouched)
   No candidates found → no prompt; all rows stay `unit`.
6. Apply the chosen policy. The user can always hand-edit the `Witness` column afterward;
   re-running UT.10 is safe (step 1 idempotency).

#### UT.10.B — `docs/SYSTEM-ACCEPTANCE.md` bootstrap (merge-preserve)

1. Compute the Active=Y `Witness:e2e` REQ set from the migrated registry.
2. **Merge-preserve** (same discipline as MODULE §3.4): if `docs/SYSTEM-ACCEPTANCE.md`
   exists, PRESERVE its §2 SYS-AC rows verbatim (Active + Status + Verified By Task +
   Date) — NEVER clobber a prior migration's or /dev's `passed` progress. Only ADD
   journeys / SYS-AC for e2e REQs not already covered; set Active=N on journeys whose REQ
   is no longer e2e.
   **§1.1 backfill (3.1.0+)**: a SYS-AC preserved from a pre-3.1.0 (bundled) file has no §1.1
   atomic-criteria definition. Backfill one — best-effort: the journey's Observable Success
   Condition becomes that preserved row's `functional` Criterion (keeping its preserved
   Active+Status). Then seed any ADDITIONAL atomic criteria the discovery identifies (NFR/SLO +
   error-path) as NEW `SYS-AC-{next}` rows (`Active=Y, Status=untested`) — so existing projects
   migrate to the atomic model without losing preserved progress. (Tier-3 heuristic: backfill the
   `functional` Criterion only + a `{TODO: add NFR/SLO + error-path}` note.)
   **§3 deferrals + header stamp (3.6.1+)**: the migrated/created file MUST mirror the Phase 3.4
   template structure — include `## 3. Accepted system-acceptance deferrals` (empty `—` placeholder
   row; merge-PRESERVE any existing §3 deferral rows verbatim) and `## 4. Change History` (map a
   pre-3.6.0 file's `## 3. Change History` by TITLE — it shifted §3→§4 in 3.6.0). Also stamp the
   header `> dev-template: v{Phase-0 banner version}` (add if absent / refresh if stale), exactly
   like main-flow Phase 3.4. Idempotent: re-running preserves §3 rows and re-stamps to current.
3. **Zero e2e REQs** → write the skeleton: stamped header (`> dev-template: v{banner version}`) +
   empty `## 1. System Acceptance Journeys` table + note "no system-behaviour requirements yet —
   all REQs unit/integration witness" + empty `## 2. System AC Ledger` + empty `## 3. Accepted
   system-acceptance deferrals` + `## 4. Change History`. Keeps the axis visible and fully inert
   (board shows `(no journeys)`; /dev `in_scope_sys_ac_ids` stays `[]`).
4. **e2e REQs present** → seed journeys:
   - Use the **emergent-journey groupings discovered in UT.10.A step 4** (Tier 1/2) as the
     primary journey set — each discovered journey → one `SYS-J` spanning its REQ-IDs. For any
     remaining e2e REQ not in a discovered journey, fall back to: REQs sharing a PRD §3 flow →
     one `SYS-J`; else one `SYS-J` per REQ. (On a Tier-3 heuristic run, groupings come only
     from this PRD-flow / per-REQ fallback.)
   - **Module Chain**: the REQ's `Module(s)` IDs, ordered by `docs/IMPLEMENTATION_ORDER.md`
     topological position when available, else registry order.
   - **Contracts**: best-effort from ARCHITECTURE §6.1 contracts on the chain seams; if not
     derivable, `(set on /spec rerun)`.
   - **Observable Success Condition**: when the REQ maps to a PRD §3 flow, copy that flow's
     Success condition (black-box); otherwise emit the literal placeholder
     `{TODO: observable success condition — fill in, or run /spec to derive}`.
   - **SYS-AC rows (atomic, 3.1.0+)**: decompose each journey into atomic criteria (≥1
     `functional`; + `nfr/slo` + `error-path` where implied) — emit each as a §1.1
     atomic-criteria row AND a §2 status row (`Active=Y, Status=untested, Witness=e2e`), one
     SYS-AC per criterion (NOT one bundled row per journey). In Tier-3 heuristic mode (no
     evaluator), seed at least the `functional` criterion per journey plus a
     `{TODO: add NFR/SLO + error-path criteria — run /spec for evaluator decomposition}` note.
   - Allocate `SYS-J-{nn}` / `SYS-AC-{nn}` continuing past the highest existing IDs (no reuse).
5. **Authorship-contract consistency**: UT.10 only creates rows and sets Active flips —
   it NEVER writes a SYS-AC to `passed` (that is `/dev` SUMMARY's exclusive write, per the
   §3.4-style partition). Witness Level on seeded SYS-AC is always `e2e`/`system`.

**Scope guard**: UT.10 runs evaluator-backed journey discovery (3.0.0+, step 4) but makes
NO other change — no touching ARCHITECTURE.md / MODULE docs (beyond the UT.2–UT.6 section merges) /
IMPLEMENTATION_ORDER.md / CONTEXT-MAP.md, and no `progress.json`. Governed by the UT.7
active-workflow gate.

### UT.9 Completion summary

After all writes succeed, emit:

```
/spec upgrade-template: upgraded N docs

Per doc:
  docs/ARCHITECTURE.md: +2 Missing, 0 Orphan, 0 Duplicate, 0 Renumbered
  docs/modules/MODULE-001-foo.md: +2 Missing, 0 Orphan, 0 Duplicate, 0 Renumbered
  docs/modules/MODULE-002-bar.md: 0 Missing, 1 Orphan (kept+annotated), 0 Duplicate, 2 Renumbered (§1.2→§1.3, §1.3→§1.4 — body+title preserved; cascaded #### subheadings + inline §-refs)

§3.4 preservation: X modules had passed AC rows preserved verbatim.
Part markers: all 3/3 present in each MODULE doc post-upgrade.
Legacy-body flags: Y (user-resolved via UT.6.1).

System-acceptance migration (UT.10):
  Journey discovery tier: {dual-evaluator | single-evaluator (Codex absent) | heuristic fallback (no evaluator)} — {N} round(s); {M} under-classified REQ(s) + {K} emergent journey(s) found
  Witness column: {added — N REQs defaulted unit, M marked e2e | already present (skipped) | n/a (no registry)}
  docs/SYSTEM-ACCEPTANCE.md: {created skeleton (0 e2e REQs) | created with {J} SYS-J / {A} atomic SYS-AC seeded | merge-preserved ({P} passed SYS-AC kept, {B} §1.1 criteria backfilled, {D} §3 deferrals kept) | n/a} — §3 Accepted-deferrals section + `> dev-template:` stamp ensured (3.6.1)
  NOTE: UT.10 ran evaluator-grade JOURNEY discovery (tier above) but did NOT regenerate
     ARCHITECTURE.md / MODULE docs — run a full `/spec` for complete spec re-convergence
     (PRD coverage, MECE, interface consistency). If the tier is "heuristic fallback", the
     journey set may be incomplete: rerun with Codex/auditor available, or run a full `/spec`.

This run's scope & unverified (factual — NEVER softening a finding):
  Not regenerated:        ARCHITECTURE.md / MODULE bodies (upgrade-template upgrades structure only).
  Not evaluator-verified: heuristic-tier journeys + any {TODO} success conditions (run a full
                          `/spec` for the rigorous Phase 1.3 system-coverage gate).
  User-resolved:          {renumber-ambiguity / Orphan / legacy-body prompts resolved above | none}

Next step: commit the changes (`git add docs/ && git commit`), then verify
downstream /dev workflows resume cleanly.
```

Phase UT exits here — it does not create `progress.json` and does not enter the
main PRD workflow.

---
