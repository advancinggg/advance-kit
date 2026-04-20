#!/usr/bin/env bash
# worktree-parallel-check.sh — 2.8.0 release verifier
#
# 11 grouped checks (T1 through T11) covering the worktree-parallel
# 2.8.0 release contract: §8 anchors + 4 subcommands + worktree
# bridging hints in /dev §2.1.2 (preserves frozen 4/3-command blocks
# from 2.7.0) + /spec §0.6 (preserves frozen 3-command blocks),
# 5-sync-point version consistency, helper script smoke + dry-run,
# Iron Rule scan, descriptor presence, VERSIONING 7-rule checklist,
# CLAUDE.md bullet.
#
# Exit 0 iff every test ends in PASS or SKIP; any FAIL exits 1
# before the epilogue.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null \
  || { echo "FAIL: not inside a git repo"; exit 1; }

# Per-run scratch dir (umask 077) — same hardening as
# upstream-alignment-check.sh.
UMASK_ORIG=$(umask)
umask 077
SCRATCH=$(mktemp -d -t wp-check.XXXXXX) \
  || { echo "FAIL: mktemp failed"; exit 1; }
umask "$UMASK_ORIG"
trap 'rm -rf "$SCRATCH"' EXIT INT TERM HUP

skipped_count=0

DEV_SKILL=plugins/dev/skills/dev/SKILL.md
SPEC_SKILL=plugins/dev/skills/spec/SKILL.md
HELPER=plugins/dev/bin/worktree-helper.sh

# ──────────────────────────────────────────────────────────────
# Fence-aware helpers (reuse pattern from upstream-alignment-check.sh)
# ──────────────────────────────────────────────────────────────

# Count lines that EXACTLY equal a literal string, OUTSIDE code fences
count_outside_fence_exact() {
  awk -v target="$2" '
    BEGIN{in_fence=0; c=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; next}
    !in_fence && $0 == target {c++}
    END{print c+0}
  ' "$1"
}

# Body extractors — fence-aware, exit on next sibling heading
extract_section() {
  # $1 = file, $2 = start anchor regex, $3 = end anchor regex
  awk -v start="$2" -v end="$3" '
    BEGIN{in_fence=0; flag=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; if (flag) print; next}
    !in_fence && $0 ~ start {flag=1; print; next}
    flag && !in_fence && $0 ~ end {exit}
    flag {print}
  ' "$1"
}

# Extract a labeled "(X) Label" sub-region (between (X) start and the next (Y) sibling)
# Uses `lo` / `hi` instead of `open` / `close` because `close` is an awk builtin.
extract_option_region() {
  # $1 = file, $2 = open label regex (e.g. "\(A\) PRD-worthy"), $3 = next sibling label regex
  awk -v lo="$2" -v hi="$3" '
    $0 ~ lo {flag=1; next}
    flag && $0 ~ hi {exit}
    flag {print}
  ' "$1"
}

# ──────────────────────────────────────────────────────────────
# T1: Syntax lint
# ──────────────────────────────────────────────────────────────
bash -n plugins/dev/bin/*.sh \
  || { echo "FAIL: T1 — bash -n on plugins/dev/bin/*.sh"; exit 1; }
jq -e . .claude-plugin/marketplace.json \
     plugins/dev/.claude-plugin/plugin.json \
     plugins/dev/hooks/hooks.json >/dev/null \
  || { echo "FAIL: T1 — jq -e on manifest + plugin + hooks JSON"; exit 1; }
echo "PASS: T1 syntax lint"

# ──────────────────────────────────────────────────────────────
# T2: Version consistency (2.8.0 in 5 sync points)
# ──────────────────────────────────────────────────────────────
PLUGIN_VER=$(jq -r .version plugins/dev/.claude-plugin/plugin.json)
MP_VER=$(jq -r '.plugins[] | select(.name=="dev") | .version' .claude-plugin/marketplace.json)
[ "$PLUGIN_VER" = "2.8.0" ] \
  || { echo "FAIL: T2 — plugin.json version is $PLUGIN_VER (expected 2.8.0)"; exit 1; }
[ "$MP_VER" = "2.8.0" ] \
  || { echo "FAIL: T2 — marketplace.json dev-entry version is $MP_VER (expected 2.8.0)"; exit 1; }
grep -qE '^\| +`dev` +\| +`2\.8\.0` +\|' README.md \
  || { echo "FAIL: T2 — README.md status row not 2.8.0"; exit 1; }
grep -qE '^\| +`dev` +\| +`2\.8\.0` +\|' README.zh-CN.md \
  || { echo "FAIL: T2 — README.zh-CN.md status row not 2.8.0"; exit 1; }
grep -qE '^\| +`dev` +\| +`2\.8\.0` +\|' README.es.md \
  || { echo "FAIL: T2 — README.es.md status row not 2.8.0"; exit 1; }
echo "PASS: T2 version consistency (5 sync points)"

# ──────────────────────────────────────────────────────────────
# T3: /dev SKILL.md §8 anchors present exactly once outside fences
# ──────────────────────────────────────────────────────────────
for anchor in \
  '## 8. Worktree mode (2.8.0+)' \
  '### 8.1 Four subcommands (labels FROZEN; see VERSIONING.md 2.8.0 rule 1)' \
  '### 8.2 Upstream coordination (/spec, /prd) — worktree-mode bridging' \
  '### 8.3 Concurrency constraints + trust boundaries'
do
  count=$(count_outside_fence_exact "$DEV_SKILL" "$anchor")
  [ "$count" = "1" ] \
    || { echo "FAIL: T3 — anchor \"$anchor\" count=$count (expected 1)"; exit 1; }
done
echo "PASS: T3 /dev SKILL.md §8 anchors (4 of them) each present exactly once"

# ──────────────────────────────────────────────────────────────
# T4: Subcommand labels in §8.1 body
# ──────────────────────────────────────────────────────────────
extract_section "$DEV_SKILL" \
  '^### 8\.1 Four subcommands' '^### 8\.2 ' \
  > "$SCRATCH/sect81.txt"
[ -s "$SCRATCH/sect81.txt" ] \
  || { echo "FAIL: T4 — §8.1 body extraction empty"; exit 1; }
for label in '/dev worktree-new' '/dev worktree-list' '/dev worktree-finish' '/dev worktree-remove'; do
  grep -Fq "$label" "$SCRATCH/sect81.txt" \
    || { echo "FAIL: T4 — §8.1 missing subcommand label '$label'"; exit 1; }
done
echo "PASS: T4 §8.1 names all 4 subcommand labels"

# ──────────────────────────────────────────────────────────────
# T5: /dev §2.1.2 preservation + worktree hints
# ──────────────────────────────────────────────────────────────
# Extract Option A region (between "(A) PRD-worthy" and "(B) Spec-only")
extract_option_region "$DEV_SKILL" '\\(A\\) PRD-worthy' '\\(B\\) Spec-only' \
  > "$SCRATCH/dev_opt_a.txt"
# Extract Option B region (between "(B) Spec-only" and "(C) In-scope")
extract_option_region "$DEV_SKILL" '\\(B\\) Spec-only' '\\(C\\) In-scope' \
  > "$SCRATCH/dev_opt_b.txt"

[ -s "$SCRATCH/dev_opt_a.txt" ] \
  || { echo "FAIL: T5.a — §2.1.2 Option A region extraction empty"; exit 1; }
[ -s "$SCRATCH/dev_opt_b.txt" ] \
  || { echo "FAIL: T5.b — §2.1.2 Option B region extraction empty"; exit 1; }

# T5.a: Option A has exactly 4 indented `/`-prefixed command lines IN
# canonical order (round-2 audit fix: ordered byte-identical contract).
grep -E '^[[:space:]]+/' "$SCRATCH/dev_opt_a.txt" | sed 's/^[[:space:]]*//' \
  > "$SCRATCH/dev_opt_a_cmds.txt"
lines=$(wc -l < "$SCRATCH/dev_opt_a_cmds.txt" | tr -d ' ')
[ "$lines" = "4" ] \
  || { echo "FAIL: T5.a — §2.1.2 Option A has $lines command lines (expected 4 — 2.7.0 frozen contract)"; exit 1; }
order=$(awk 'NR==1 && /^\/dev abort$/{printf "1"}
             NR==2 && /^\/prd "/{printf "2"}
             NR==3 && /^\/spec docs\/PRD\.md$/{printf "3"}
             NR==4 && /^\/dev \{/{printf "4"}
             END{printf "\n"}' "$SCRATCH/dev_opt_a_cmds.txt")
[ "$order" = "1234" ] \
  || { echo "FAIL: T5.a — §2.1.2 Option A canonical order broken (got '$order', expected 1234)"; exit 1; }
echo "PASS: T5.a §2.1.2 Option A preserved (4 commands, canonical order)"

# T5.b: Option B has exactly 3 indented `/`-prefixed command lines IN
# canonical order.
grep -E '^[[:space:]]+/' "$SCRATCH/dev_opt_b.txt" | sed 's/^[[:space:]]*//' \
  > "$SCRATCH/dev_opt_b_cmds.txt"
lines=$(wc -l < "$SCRATCH/dev_opt_b_cmds.txt" | tr -d ' ')
[ "$lines" = "3" ] \
  || { echo "FAIL: T5.b — §2.1.2 Option B has $lines command lines (expected 3 — 2.7.0 frozen contract)"; exit 1; }
order_b=$(awk 'NR==1 && /^\/dev abort$/{printf "1"}
               NR==2 && /^\/spec([[:space:]]|$|[[:space:]]+#)/{printf "2"}
               NR==3 && /^\/dev \{/{printf "3"}
               END{printf "\n"}' "$SCRATCH/dev_opt_b_cmds.txt")
[ "$order_b" = "123" ] \
  || { echo "FAIL: T5.b — §2.1.2 Option B canonical order broken (got '$order_b', expected 123)"; exit 1; }
echo "PASS: T5.b §2.1.2 Option B preserved (3 commands, canonical order)"

# T5.c: Option A body contains "Worktree mode" hint
grep -Fq 'Worktree mode' "$SCRATCH/dev_opt_a.txt" \
  || { echo "FAIL: T5.c — §2.1.2 Option A missing 'Worktree mode' hint"; exit 1; }
echo "PASS: T5.c §2.1.2 Option A has Worktree mode hint"

# T5.d: Option B body contains "Worktree mode" hint
grep -Fq 'Worktree mode' "$SCRATCH/dev_opt_b.txt" \
  || { echo "FAIL: T5.d — §2.1.2 Option B missing 'Worktree mode' hint"; exit 1; }
echo "PASS: T5.d §2.1.2 Option B has Worktree mode hint"

# ──────────────────────────────────────────────────────────────
# T6: /spec §0.6 preservation + worktree hints
# ──────────────────────────────────────────────────────────────
extract_option_region "$SPEC_SKILL" '\\(A\\) PRD-worthy via /prd' '\\(B\\) User manually edits PRD' \
  > "$SCRATCH/spec_opt_a.txt"
extract_option_region "$SPEC_SKILL" '\\(B\\) User manually edits PRD' '\\(C\\) Assumption documented' \
  > "$SCRATCH/spec_opt_b.txt"

[ -s "$SCRATCH/spec_opt_a.txt" ] \
  || { echo "FAIL: T6.a — /spec §0.6 Option A region extraction empty"; exit 1; }
[ -s "$SCRATCH/spec_opt_b.txt" ] \
  || { echo "FAIL: T6.b — /spec §0.6 Option B region extraction empty"; exit 1; }

# T6.a: §0.6 Option A has exactly 3 indented `/`-prefixed command lines
# IN canonical order (/spec abort → /prd "..." → /spec docs/PRD.md)
grep -E '^[[:space:]]+/' "$SCRATCH/spec_opt_a.txt" | sed 's/^[[:space:]]*//' \
  > "$SCRATCH/spec_opt_a_cmds.txt"
lines=$(wc -l < "$SCRATCH/spec_opt_a_cmds.txt" | tr -d ' ')
[ "$lines" = "3" ] \
  || { echo "FAIL: T6.a — /spec §0.6 Option A has $lines command lines (expected 3)"; exit 1; }
order_a=$(awk 'NR==1 && /^\/spec abort$/{printf "1"}
               NR==2 && /^\/prd "/{printf "2"}
               NR==3 && /^\/spec docs\/PRD\.md$/{printf "3"}
               END{printf "\n"}' "$SCRATCH/spec_opt_a_cmds.txt")
[ "$order_a" = "123" ] \
  || { echo "FAIL: T6.a — /spec §0.6 Option A canonical order broken (got '$order_a', expected 123)"; exit 1; }
echo "PASS: T6.a /spec §0.6 Option A preserved (3 commands, canonical order)"

# T6.b: §0.6 Option B contains the canonical 3-line code block:
# 2 indented slash-commands at 7-space indent + 1 indented `# comment`.
# Use 7+ space indent to distinguish CODE-block lines from PROSE
# continuation (which uses 5-space indent in /spec §0.6).
slash_lines=$(grep -cE '^[[:space:]]{7,}/' "$SCRATCH/spec_opt_b.txt" || true)
comment_lines=$(grep -cE '^[[:space:]]{7,}#' "$SCRATCH/spec_opt_b.txt" || true)
[ "$slash_lines" = "2" ] && [ "$comment_lines" -ge "1" ] \
  || { echo "FAIL: T6.b — /spec §0.6 Option B (slash=$slash_lines, comment=$comment_lines; expected slash=2 + ≥1 comment at 7+ space indent)"; exit 1; }
echo "PASS: T6.b /spec §0.6 Option B preserved (2 slash + ≥1 comment)"

# T6.c: §0.6 Option A contains "Worktree mode" hint
grep -Fq 'Worktree mode' "$SCRATCH/spec_opt_a.txt" \
  || { echo "FAIL: T6.c — /spec §0.6 Option A missing 'Worktree mode' hint"; exit 1; }
echo "PASS: T6.c /spec §0.6 Option A has Worktree mode hint"

# T6.d: §0.6 Option B contains "Worktree mode" hint
grep -Fq 'Worktree mode' "$SCRATCH/spec_opt_b.txt" \
  || { echo "FAIL: T6.d — /spec §0.6 Option B missing 'Worktree mode' hint"; exit 1; }
echo "PASS: T6.d /spec §0.6 Option B has Worktree mode hint"

# ──────────────────────────────────────────────────────────────
# T7: helper script smoke test (incl. --dry-run)
# ──────────────────────────────────────────────────────────────
[ -x "$HELPER" ] \
  || { echo "FAIL: T7 — $HELPER not executable"; exit 1; }
bash -n "$HELPER" \
  || { echo "FAIL: T7 — bash -n failed on $HELPER"; exit 1; }

# Bare invocation → usage to stderr + exit non-zero
if bash "$HELPER" 2>/dev/null; then
  echo "FAIL: T7 — bare invocation should exit non-zero"; exit 1
fi

# `list` exits 0 + prints header
list_out=$(bash "$HELPER" list 2>&1) || { echo "FAIL: T7 — list exited non-zero"; exit 1; }
echo "$list_out" | head -1 | grep -Fq 'PATH' \
  || { echo "FAIL: T7 — list header missing"; exit 1; }

# `new test-xyz-NNNN --dry-run` → exit 0, no fs state created. Use
# random suffix to avoid collisions with pre-existing dirs on dev machines.
test_slug="test-xyz-$$"
target_dir="$(dirname "$(pwd)")/$(basename "$(pwd)")-${test_slug}"
if [ -e "$target_dir" ]; then
  # Should be very rare (PID collision). Skip rather than fail.
  echo "SKIP: T7 dry-run new — target dir already exists: $target_dir"
  skipped_count=$((skipped_count+1))
else
  dry_out=$(bash "$HELPER" new "$test_slug" --dry-run 2>&1) \
    || { echo "FAIL: T7 — new --dry-run exited non-zero"; echo "$dry_out" | sed 's/^/  > /'; exit 1; }
  # Verify dry-run printed the planned command (not silent success)
  echo "$dry_out" | grep -Fq 'git worktree add' \
    || { echo "FAIL: T7 — new --dry-run missing 'git worktree add' in preview"; echo "$dry_out" | sed 's/^/  > /'; exit 1; }
  [ ! -e "$target_dir" ] \
    || { echo "FAIL: T7 — new --dry-run created target dir: $target_dir"; rm -rf "$target_dir"; exit 1; }
fi

# `remove /nonexistent --dry-run` → exit non-zero (validation fails)
if bash "$HELPER" remove /nonexistent/path --dry-run 2>/dev/null; then
  echo "FAIL: T7 — remove /nonexistent should exit non-zero"; exit 1
fi
echo "PASS: T7 helper script smoke + dry-run"

# ──────────────────────────────────────────────────────────────
# T8: Iron Rule negative scan on 6 extracted bodies
# ──────────────────────────────────────────────────────────────
# Extract §8.1 / §8.2 / §8.3 / new CLAUDE.md bullet
extract_section "$DEV_SKILL" \
  '^### 8\.1 ' '^### 8\.2 ' \
  > "$SCRATCH/sect81_iron.txt"
extract_section "$DEV_SKILL" \
  '^### 8\.2 ' '^### 8\.3 ' \
  > "$SCRATCH/sect82_iron.txt"
extract_section "$DEV_SKILL" \
  '^### 8\.3 ' '^## ' \
  > "$SCRATCH/sect83_iron.txt"
awk '
  BEGIN{prev_blank=0; flag=0}
  /^- \/dev supports worktree-parallel execution/{flag=1; print; next}
  flag {
    if (/^##/) {exit}
    if (/^- / && $0 !~ /^- \/dev supports worktree-parallel/) {exit}
    if (prev_blank && !/^  / && !/^-/) {exit}
    print
    prev_blank = (NF == 0)
  }
' .claude/CLAUDE.md > "$SCRATCH/claude_bullet.txt"

# Combined hint paragraphs from /dev §2.1.2 A+B and /spec §0.6 A+B
cat "$SCRATCH/dev_opt_a.txt" "$SCRATCH/dev_opt_b.txt" \
  > "$SCRATCH/dev_212_hints.txt"
cat "$SCRATCH/spec_opt_a.txt" "$SCRATCH/spec_opt_b.txt" \
  > "$SCRATCH/spec_06_hints.txt"

cat > "$SCRATCH/forbidden.txt" <<'EOF'
Known unfixed
Known issues, logged for you
Known issues
Known gaps
Out-of-Scope
Out of scope
Deferred work
Deferred
TODO for you
TODO: fix later
TODO:
TODO
Skip for now
Follow up later
v2 deferred
Needs follow-up design
Pending refinement
To be addressed later
EOF

if cat "$SCRATCH/sect81_iron.txt" "$SCRATCH/sect82_iron.txt" \
       "$SCRATCH/sect83_iron.txt" "$SCRATCH/claude_bullet.txt" \
       "$SCRATCH/dev_212_hints.txt" "$SCRATCH/spec_06_hints.txt" \
     | grep -F -f "$SCRATCH/forbidden.txt" >"$SCRATCH/violations.txt" 2>/dev/null; then
  if [ -s "$SCRATCH/violations.txt" ]; then
    echo "FAIL: T8 — Iron Rule violations:"
    sed 's/^/  > /' "$SCRATCH/violations.txt"
    exit 1
  fi
fi
echo "PASS: T8 Iron Rule negative scan on 6 bodies"

# ──────────────────────────────────────────────────────────────
# T9: descriptor presence
# ──────────────────────────────────────────────────────────────
grep -Fq 'worktree' README.md \
  || { echo "FAIL: T9 — README.md missing 'worktree' marker"; exit 1; }
grep -Fq 'worktree' README.zh-CN.md \
  || { echo "FAIL: T9 — README.zh-CN.md missing 'worktree' marker"; exit 1; }
grep -Fq 'worktree' README.es.md \
  || { echo "FAIL: T9 — README.es.md missing 'worktree' marker"; exit 1; }
jq -r '.description' plugins/dev/.claude-plugin/plugin.json | grep -Fq '**2.8.0**' \
  || { echo "FAIL: T9 — plugin.json description missing '**2.8.0**'"; exit 1; }
jq -r '.plugins[] | select(.name=="dev") | .description' .claude-plugin/marketplace.json | grep -Fq '**2.8.0**' \
  || { echo "FAIL: T9 — marketplace.json dev-entry description missing '**2.8.0**'"; exit 1; }
echo "PASS: T9 descriptor presence"

# ──────────────────────────────────────────────────────────────
# T10: VERSIONING.md 2.8.0 checklist (7 rules + 2.7.0-still-in-force note)
# ──────────────────────────────────────────────────────────────
grep -Fq '## Release checklist (for worktree-parallel — 2.8.0+)' .claude/VERSIONING.md \
  || { echo "FAIL: T10 — VERSIONING.md missing 2.8.0 release checklist"; exit 1; }
rule_count=$(awk '
  /^## Release checklist \(for worktree-parallel — 2\.8\.0\+\)/{flag=1; next}
  flag && /^## /{exit}
  flag && /^[0-9]+\.[[:space:]]/{c++}
  END{print c+0}
' .claude/VERSIONING.md)
[ "$rule_count" -eq 7 ] \
  || { echo "FAIL: T10 — VERSIONING.md 2.8.0 checklist has $rule_count rules (expected 7)"; exit 1; }
grep -Fq '2.7.0' .claude/VERSIONING.md \
  || { echo "FAIL: T10 — VERSIONING.md missing 2.7.0 rules-still-in-force note"; exit 1; }
# More specific: check for the literal phrase
grep -Fq 'REMAIN in force' .claude/VERSIONING.md \
  || { echo "FAIL: T10 — VERSIONING.md missing 'REMAIN in force' acknowledgment"; exit 1; }
echo "PASS: T10 VERSIONING.md 2.8.0 checklist (7 rules + 2.7.0 preservation note)"

# ──────────────────────────────────────────────────────────────
# T11: CLAUDE.md new bullet
# ──────────────────────────────────────────────────────────────
match_count=$(grep -cF 'worktree-parallel execution' .claude/CLAUDE.md || true)
[ "$match_count" -eq 1 ] \
  || { echo "FAIL: T11 — CLAUDE.md 'worktree-parallel execution' count=$match_count (expected 1)"; exit 1; }
echo "PASS: T11 CLAUDE.md worktree-parallel bullet present"

# ──────────────────────────────────────────────────────────────
# Epilogue
# ──────────────────────────────────────────────────────────────
total=11
ran=$((total - skipped_count))
if [ "$skipped_count" = "0" ]; then
  echo "Tests: ${total}/${total} passed (100%)"
else
  echo "Tests: ${ran}/${total} passed, ${skipped_count} skipped (100% of runnable)"
fi
exit 0
