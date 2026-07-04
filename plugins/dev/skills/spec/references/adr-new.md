# /spec Phase ADR-NEW — `/spec adr-new` subcommand (reference body)

> Loaded on demand by `plugins/dev/skills/spec/SKILL.md` §0.0 dispatch (3.9.0
> progressive disclosure). Execute with full SKILL.md authority. The `## ADR Template`
> block this procedure extracts lives INLINE in SKILL.md (frozen, VERSIONING ADR
> rule 3) — template extraction targets SKILL.md, never this file. UT.x references
> resolve to `references/phase-ut.md`.


## Phase ADR-NEW: `/spec adr-new "<title>"` subcommand

Standalone subcommand, invoked via the `§0.0` dispatch branch. Does NOT touch `docs/.spec-state/progress.json`. All side-effects (mkdir, file create, `_INDEX.md` append) are deferred until after the active-workflow gate and cross-day collision check pass.

**Canonical filename grammar (2.5.0+, frozen by VERSIONING rule 1):**

```
filename  ::= date '-' slug ('__' suffix)? '.md'
date      ::= YYYY '-' MM '-' DD (ISO 8601)
slug      ::= 1..8 kebab-case words; total length ≥ 2 chars;
              [a-z0-9] first char, [a-z0-9-] interior chars,
              [a-z0-9] last char (single-char slugs rejected at creation)
suffix    ::= 2-99 integer (collision suffix; NEVER 1, NEVER ≥100)
```

The double-underscore separator `__` for collision suffixes unambiguously distinguishes them from semantic slugs ending in digits (e.g., `use-http-2` is a slug; `foo__2` is slug `foo` with collision suffix N=2). Slugs never contain `__` — only single hyphens between alphanumeric words.

**Execution (7 steps):**

**Preamble — concurrency lock (acquired BEFORE step 1, released on any exit path)**: first `mkdir -p docs/adr/` (the parent must exist to host the lock), then `mkdir docs/adr/.adr-new.lock.d 2>/dev/null` (portable atomic lock — returns non-zero if the directory already exists). If lock acquisition fails, check the lockfile's mtime: if older than **600 seconds** (10 min — accommodates interactive AskUserQuestion waits in the collision-scan and active-workflow-gate branches, which can legitimately block a session for minutes) → warn `Stale lock detected (age >600s); auto-removing.`, `rmdir` it, and retry `mkdir` ONCE. If the retry also fails OR the lockfile is fresh (<600s) → print `Another /spec adr-new is currently active (lockfile docs/adr/.adr-new.lock.d); retry in a moment. If the process is definitely dead, remove the lockfile manually.` and exit 1. On success, install `trap 'rmdir docs/adr/.adr-new.lock.d' EXIT` so any exit path (normal, error, SIGINT) releases the lock. **Race-free stale recovery**: to avoid the double-rmdir race where two callers both see stale + both rmdir + the winner's fresh mkdir gets rmdir'd by the loser, use a secondary sentinel — after the rmdir-on-stale step, do `mkdir docs/adr/.adr-new.lock.d || exit 1` (fail on ANY race loss), THEN verify by `test -d docs/adr/.adr-new.lock.d` after a short jitter sleep. If the test fails, abort. This serializes the entire collision-scan + filename-decision + write critical section.

**ADR path-confinement check (2.5.0+ adversarial-hardening)**: all ADR file reads/writes under `docs/adr/` must verify the resolved real path is still under `docs/adr/` (reject symlinks that escape). Implementation uses **`python3 -I`** (isolated mode — ignores `PYTHONPATH` and does NOT prepend CWD to `sys.path`, preventing attacker-planted `os.py` in the repo from hijacking `import os`) AND passes paths via `sys.argv` (NOT shell interpolation, so repo paths containing `'` cannot break out of the Python string):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# First verify docs/adr itself is NOT a symlink AND its realpath is under REPO_ROOT.
# Without this, an attacker-planted `docs/adr -> /etc/` symlink would blessen-by-realpath
# every file under /etc (ADR_DIR_REAL becomes the escape destination, defeating the guard).
ADR_DIR_REAL=$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$REPO_ROOT/docs/adr")
REPO_ROOT_REAL=$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$REPO_ROOT")
case "$ADR_DIR_REAL/" in
  "$REPO_ROOT_REAL/"*) : ;;
  *) printf '%s\n' "Refusing: docs/adr resolves to $ADR_DIR_REAL (outside repo $REPO_ROOT_REAL) — likely a symlink escape at the docs/adr level itself." >&2; exit 1 ;;
esac
# Also verify docs/adr is a real directory, not a symlink at the filesystem level:
if [ -L "$REPO_ROOT/docs/adr" ]; then
  printf '%s\n' "Refusing: $REPO_ROOT/docs/adr is a symlink; refusing to treat as ADR directory." >&2
  exit 1
fi
check_path() {
  local f="$1"
  local abs=$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$f")
  case "$abs" in
    "$ADR_DIR_REAL/"*) return 0 ;;
    *) printf '%s\n' "Refusing to access $f — symlink escape: resolves to $abs (outside $ADR_DIR_REAL)" >&2; return 1 ;;
  esac
}
```

This applies to: Phase 1.0 step 2 parser (read), Phase 1.0 step 5 ADR mutations (write), Phase 1.0 step 7 `_INDEX.md` rebuild (read-all + overwrite), Phase ADR-NEW step 7 template write + `_INDEX.md` append, and `/dev` §1.1 ADR loads (both fresh-path from CONTEXT-MAP and fallback direct scan). Downstream, adds negligible latency (one realpath per file) and blocks the symlink-to-arbitrary-file tampering vector. The `-I` flag matches the defense already used in `/dev` §1.1's `check_context_map_staleness` snippet.

1. Parse `$ARGUMENTS` → extract title. Missing title → print usage `/spec adr-new "<title>" — no title provided.` and exit.

2. Normalize title → `slug`:
   - lowercase; replace any non `[a-z0-9]+` run with `-`; strip leading/trailing `-`; collapse runs of `-`.
   - Word count: 1..8 kebab-case words (single-word titles like "authentication" are valid). If >8 words after normalization, keep the first 8.
   - Total slug length must be ≥ 2 chars. If the normalized slug is a single character (e.g., title "X" → slug "x"), print an error `/spec adr-new: slug "{slug}" is too short (minimum 2 characters). Pick a more descriptive title.` and exit.

3. **Cross-day base-slug collision check (runs BEFORE any side-effect)**. Scan `docs/adr/*.md` (if dir exists) and detect filename collisions using the canonical filter regex + collision-suffix test:
   ```bash
   # Slug must already be shell-safe kebab-case from step 2.
   # Filter regex: ISO YYYY-MM-DD + slug grammar (≥2 chars) + optional __N (N: 2..99).
   filter_re='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-[a-z0-9][a-z0-9-]*[a-z0-9](__([2-9]|[1-9][0-9]))?$'
   collision_re="^${slug}__([2-9]|[1-9][0-9])\$"
   found=""
   for f in docs/adr/*.md; do
     [ -f "$f" ] || continue
     bn=$(basename "$f" .md)
     printf '%s\n' "$bn" | grep -Eq "$filter_re" || continue
     rest="${bn:11}"
     # Match canonical slug (no suffix) OR slug + __N collision suffix
     if [ "$rest" = "$slug" ] || printf '%s\n' "$rest" | grep -Eq "$collision_re"; then
       found="$found $f"
     fi
   done
   ```

   **Filter regex coverage**:
   - Accepts: `2026-04-18-use-http-2.md` (semantic slug ending in digit), `2026-04-18-foo__2.md` (collision N=2), `2026-04-18-foo__99.md` (N=99), `2026-04-18-use-oauth.md`.
   - Rejects: `_TEMPLATE.md`, `_INDEX.md`, files without date prefix, malformed dates, slugs with leading/trailing hyphen, single-char slugs, `foo__1.md`, `foo__100.md`, `foo_2.md` (single underscore).
   - Word-count / doubled-hyphen enforcement is at creation (step 2), not in the filter regex: hand-edited legacy files that violate the ≤8-word convention are still matched by the filter for collision-check purposes (harmless).

   **Disambiguation examples** (slug-match under the `__N` separator):
   - New slug `use-http-2` vs existing `2026-03-15-use-http-2.md`: canonical match (rest == slug). Correct.
   - New slug `use-http-2` vs existing `2026-03-15-use-http-2__3.md`: collision-suffix test matches N=3. Correct.
   - New slug `foo` vs existing `2026-03-15-foo-123.md`: neither match (rest `foo-123` ≠ `foo`; `foo__[2-9]|[1-9][0-9]$` does NOT match `foo-123`). **No collision reported** — correct, since `foo-123` is a semantically distinct slug.
   - New slug `foo` vs existing `2026-03-15-foo__5.md`: collision-suffix matches N=5. Correct.

   If any file matches → AskUserQuestion: "An existing ADR uses base slug `{slug}`: {list}. Options: (A) Create a new same-day variant (filename will be auto-suffixed with `__N` if needed); (B) Abort — I'll edit the existing ADR instead (filename printed)." Option A → continue to step 4; Option B → exit with first-match path printed. **Nothing is written to disk at this step.**

4. **Active-workflow gate** (UT.7-aligned). Define:
   - `block-prompt set = {architecture, modules, implementation_order}` — phases that trigger the AskUserQuestion prompt below.
   - `safe-proceed set = {init, report, file-absent}` — phases (or missing progress.json) that proceed without prompting.

   Read `docs/.spec-state/progress.json`. If the file exists AND `.phase ∈ block-prompt set` → AskUserQuestion "A /spec main workflow is currently in phase {phase}. /spec adr-new is standalone (doesn't modify progress.json) but writes into `docs/adr/` while main /spec is regenerating module docs — this can race. Options: (A) Proceed anyway; (B) Abort and rerun after the main workflow completes." Otherwise (safe-proceed set or file absent) → proceed without prompting. **Nothing is written to disk at this step.**

5. Compute `filename = docs/adr/$(date +%Y-%m-%d)-{slug}.md`. Same-day collision: if the target file exists, try `{date}-{slug}__2.md`, `__3`, ..., up to `__99` (double-underscore separator per the canonical grammar). Error out on overflow with "99 same-day same-slug variants already exist — please pick a more specific title". **Nothing is written to disk at this step** (only the winning filename is decided).

6. Resolve SKILL.md path and read ADR Template body:
   - **Tier 1 (preferred)**: `$CLAUDE_PLUGIN_ROOT/skills/spec/SKILL.md` (set by the plugin runtime). Before use, run the same UT.4-style fence-aware scan (below) to verify the file contains the exact line `## ADR Template` **outside all code fences** AND that the next ```markdown fence is locatable after the anchor. A simple `grep -q` is insufficient because SKILL.md may cite `## ADR Template` as a prose example inside a fenced code block. If the fence-aware scan fails (env var points at a stale pre-2.5.0 plugin install still in cache), fall through to Tier 2.
   - **Tier 2 (fallback)**: semver-filtered, semver-sorted cache lookup — `ls ~/.claude/plugins/cache/advance-kit/dev/ 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1` first filters for strict semver-shaped directory names, then sorts by version. **Cache trust check (2.5.0+ adversarial-hardening)**: before reading the selected version's SKILL.md, verify `stat -f %u ~/.claude/plugins/cache/advance-kit/dev/{version}` (BSD) OR `stat -c %u` (GNU) equals the current process user (`id -u`); if ownership differs → abort immediately with `/spec adr-new: plugin cache entry is not owned by this user — refusing to read potentially tampered SKILL.md. Set $CLAUDE_PLUGIN_ROOT manually or reinstall the dev plugin.` This defeats shared-host attacks where a colocated user pre-populates a high-version directory. **macOS compatibility**: `sort -V` is available in BSD sort on macOS Monterey (12.0) and later. Pre-macOS-12 silently degrades to lexical sort (picks `2.9.0` over `2.10.0` — rely on Tier-1 in that case). If the filtered list is empty (cache directory missing or no semver-shaped subdirs) → proceed immediately to Tier-3. Otherwise Read `~/.claude/plugins/cache/advance-kit/dev/{version}/skills/spec/SKILL.md` and re-run the fence-aware scan on this candidate; if `## ADR Template` is absent (e.g., cache only holds pre-2.5.0 versions), Tier-2 fails and falls to Tier-3.
   - **Tier 3 (final abort)**: print `/spec adr-new: Could not locate a spec SKILL.md with a 2.5.0+ '## ADR Template' section. The advance-kit dev plugin may be installed but its cache hasn't been populated for the running version — restart Claude Code (re-populates the plugin cache on next invocation), or set $CLAUDE_PLUGIN_ROOT manually to your dev plugin directory.` and exit 1.
   - **UT.4-style protocol (literal-line anchor + fence-tracking, depth-2 variant)**: scan the file line-by-line. Track code fences using UT.5 rule 1 (fence open = line at column 0 with 3+ consecutive backticks/tildes; fence close = line with only the same char of length ≥ opener). Find the FIRST line that EQUALS `## ADR Template` (literal string match, outside all fences). From there, advance to the first line that EQUALS ` ```markdown ` (column-0 opener). Capture all subsequent lines until the matching close fence ` ``` `. The captured body is the template source.
   - Sanitize the title for Markdown / parser safety: strip ALL of: pipe `|` (corrupts `_INDEX.md` table rows), newlines `\n\r`, backtick runs `` `+ ``, NUL `\0`, tab `\t`, form feed `\f`, backslash `\\`, square brackets `[]` (prevents Markdown reference-link injection like `[inner](javascript:alert)`), angle brackets `<>` (defeats auto-link + HTML tag injection), HTML-entity prefix `&` (defeats entity-encoded payloads like `&#60;img&#62;` that decode back to `<img>` in rendering pipelines), HTML-comment start `<!--`, Unicode BIDI override chars `U+202A..U+202E` and `U+2066..U+2069` (defeats RTL-spoofing), zero-width chars `U+200B..U+200D` and `U+FEFF`, and leading/trailing whitespace. If the resulting sanitized title is empty → error "Title contains only unsafe characters; pick a different title" and exit. Substitute `{Title}` with the sanitized title; substitute `{YYYY-MM-DD}` in the `> Date:` line with today's ISO date (`date +%Y-%m-%d`). Leave all other placeholders as editable text.

7. **All side-effects happen here** (after steps 1–6 have passed; lock is already held from the preamble).

   **Ordering rule for partial-failure recovery**: write the ADR `.md` file BEFORE touching `_INDEX.md`. If the process dies between steps, an orphan ADR file exists (recoverable by the next `/spec` Phase 1.0 step 7 full rebuild), but a stale `_INDEX.md` row pointing at a nonexistent file does NOT occur (would require reverse-write-order).

   - `mkdir -p docs/adr/`
   - Write template body to the filename computed in step 5 (use `mktemp docs/adr/.{slug}-XXXXXX.tmp` + `mv` for atomicity on POSIX rename semantics).
   - After successful template write, append a row to `docs/adr/_INDEX.md` (create with the canonical 2-table skeleton if missing):
     ```
     # ADR Index

     > Auto-maintained by /spec. Do not edit manually.
     > Last updated: {ISO date}

     | Filename | Date | Title | Status | Modules affected |
     |----------|------|-------|--------|------------------|
     | YYYY-MM-DD-{slug}.md | YYYY-MM-DD | {Title} | Proposed | (none) |

     ## Superseded

     | Filename | Superseded by | Date |
     |----------|---------------|------|
     ```
   - Console: `Created: docs/adr/YYYY-MM-DD-{slug}.md (Status: Proposed). Edit Context/Options/Decision/Rationale/Consequences/Related, change Status to Accepted, and rerun /spec to pick it up in ARCHITECTURE §8.`
   - **Modules-affected prompt (3.9.0)**: after creating the file, if `docs/modules/` exists,
     offer ONE AskUserQuestion listing the known `MODULE-NNN` IDs (multiSelect) to fill the
     `Related > Modules affected:` bullet immediately — an ADR left at the `(none)` template
     default is INVISIBLE to Phase 1.0 conflict detection (condition (a) evaluates
     empty ∩ empty = ∅). Declining leaves `(none)` (allowed, but note the warning).

Phase ADR-NEW exits here — it does not create `progress.json` and does not enter the main PRD workflow.

---
