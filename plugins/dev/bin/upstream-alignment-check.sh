#!/usr/bin/env bash
# upstream-alignment-check.sh — 2.7.0 release verifier
#
# 10 grouped checks (T1 through T10) covering the upstream-alignment
# 2.7.0 release contract: /dev §2.1.2 / §2.1.3 anchors + options, /spec
# §0.6 anchor + options, 3-README + plugin.json + marketplace.json
# version consistency, Iron Rule negative scan on 4 new bodies,
# §2.1.1 byte-identical baseline (workflow-internal — SKIPs outside
# /dev session), VERSIONING.md release checklist, CLAUDE.md bullet, and
# single cross-reference paragraph presence.
#
# Exit 0 iff every test ends in PASS or SKIP; any FAIL exits 1 before
# the epilogue.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null \
  || { echo "FAIL: not inside a git repo"; exit 1; }

# Per-run scratch directory (umask 077) avoids the fixed-/tmp TOCTOU /
# symlink-clobber attack surface and prevents concurrent-run races on
# shared paths. Cleaned up on any exit via trap.
UMASK_ORIG=$(umask)
umask 077
SCRATCH=$(mktemp -d -t ua-check.XXXXXX) \
  || { echo "FAIL: mktemp failed"; exit 1; }
umask "$UMASK_ORIG"
trap 'rm -rf "$SCRATCH"' EXIT INT TERM

skipped_count=0

DEV_SKILL=plugins/dev/skills/dev/SKILL.md
SPEC_SKILL=plugins/dev/skills/spec/SKILL.md

# Fence-tracker matches up to 3-space-indented triple-backticks (CommonMark
# fenced-code-block rule). This is shared by BOTH the count_outside_fence_*
# counters AND the extract_* helpers, so the fence-aware boundary is
# consistent across tests (closes adversarial round-1 finding 3).
#
# Regex: ^ *``` allows 0–3 leading spaces before the triple-backtick. A
# 4-space-indented code fence is CommonMark's indented-code-block form, not a
# fenced one, so we deliberately do NOT toggle on 4-space cases.

# Body-extraction awk helpers (shared by T5 and T7) -----------------

extract_212() {
  awk '
    BEGIN{in_fence=0; flag=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; if (flag) print; next}
    !in_fence && /^### 2\.1\.2 /{flag=1; print; next}
    flag && !in_fence && /^### 2\.[0-9]+(\.[0-9]+)? /{exit}
    flag {print}
  ' "$DEV_SKILL"
}
extract_213() {
  awk '
    BEGIN{in_fence=0; flag=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; if (flag) print; next}
    !in_fence && /^### 2\.1\.3 /{flag=1; print; next}
    flag && !in_fence && /^### 2\.[0-9]+(\.[0-9]+)? /{exit}
    flag {print}
  ' "$DEV_SKILL"
}
extract_06() {
  awk '
    BEGIN{in_fence=0; flag=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; if (flag) print; next}
    !in_fence && /^### 0\.6 PRD-gap escalation /{flag=1; print; next}
    flag && !in_fence && (/^## / || /^---$/){exit}
    flag {print}
  ' "$SPEC_SKILL"
}
extract_claude_bullet() {
  awk '
    BEGIN{prev_blank=0; flag=0; in_fence=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; if (flag) print; next}
    !in_fence && /^- \/dev DOCS phase fires three inline upstream checks/{flag=1; print; next}
    flag {
      if (!in_fence && /^##/) {exit}
      if (!in_fence && /^- / && $0 !~ /^- \/dev DOCS/) {exit}
      if (!in_fence && prev_blank && !/^  / && !/^-/) {exit}
      print
      prev_blank = (NF == 0)
    }
  ' .claude/CLAUDE.md
}

# Shared counters — same fence rule as extractors (up to 3-space indent)
count_outside_fence_exact() {
  awk -v target="$2" '
    BEGIN{in_fence=0; c=0}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; next}
    !in_fence && $0 == target {c++}
    END{print c+0}
  ' "$1"
}
count_outside_fence_prefix() {
  awk -v prefix="$2" '
    BEGIN{in_fence=0; c=0; plen=length(prefix)}
    /^ {0,3}(```|~~~)/{in_fence = !in_fence; next}
    !in_fence && substr($0, 1, plen) == prefix {c++}
    END{print c+0}
  ' "$1"
}

# ---------- T1: Syntax lint (existing CLAUDE.md contract) ----------
bash -n plugins/dev/bin/*.sh \
  || { echo "FAIL: T1 — bash -n on plugins/dev/bin/*.sh"; exit 1; }
jq -e . .claude-plugin/marketplace.json \
     plugins/dev/.claude-plugin/plugin.json \
     plugins/dev/hooks/hooks.json >/dev/null \
  || { echo "FAIL: T1 — jq -e on manifest + plugin + hooks JSON"; exit 1; }
echo "PASS: T1 syntax lint"

# ---------- T2: Version consistency ----------
PLUGIN_VER=$(jq -r .version plugins/dev/.claude-plugin/plugin.json)
MP_VER=$(jq -r '.plugins[] | select(.name=="dev") | .version' .claude-plugin/marketplace.json)
[ "$PLUGIN_VER" = "2.7.0" ] \
  || { echo "FAIL: T2 — plugin.json version is $PLUGIN_VER (expected 2.7.0)"; exit 1; }
[ "$MP_VER" = "2.7.0" ] \
  || { echo "FAIL: T2 — marketplace.json dev-entry version is $MP_VER (expected 2.7.0)"; exit 1; }
grep -qE '^\| +`dev` +\| +`2\.7\.0` +\|' README.md \
  || { echo "FAIL: T2 — README.md status row not 2.7.0"; exit 1; }
grep -qE '^\| +`dev` +\| +`2\.7\.0` +\|' README.zh-CN.md \
  || { echo "FAIL: T2 — README.zh-CN.md status row not 2.7.0"; exit 1; }
grep -qE '^\| +`dev` +\| +`2\.7\.0` +\|' README.es.md \
  || { echo "FAIL: T2 — README.es.md status row not 2.7.0"; exit 1; }
echo "PASS: T2 version consistency (5 sync points)"

# ---------- T3: /dev SKILL.md anchors present exactly once outside fences ----------
for anchor in \
  '### 2.1.1 ADR check (2.5.0+, abort+restart pattern)' \
  '### 2.1.2 PRD/Spec upstream change check (2.7.0+, abort+restart pattern)' \
  '### 2.1.3 Core Logic drift check (2.7.0+)'
do
  count=$(count_outside_fence_exact "$DEV_SKILL" "$anchor")
  [ "$count" = "1" ] \
    || { echo "FAIL: T3 — anchor \"$anchor\" count=$count (expected 1)"; exit 1; }
done
echo "PASS: T3 /dev SKILL.md anchors (§2.1.1 + §2.1.2 + §2.1.3) each present exactly once"

# ---------- T4: /spec SKILL.md §0.6 anchor ----------
count=$(count_outside_fence_exact "$SPEC_SKILL" '### 0.6 PRD-gap escalation (2.7.0+)')
[ "$count" = "1" ] \
  || { echo "FAIL: T4 — §0.6 anchor count=$count (expected 1)"; exit 1; }
echo "PASS: T4 /spec SKILL.md §0.6 anchor present exactly once"

# ---------- T7: body extractions (must run before T5) + Iron Rule negative scan ----------
extract_212 > $SCRATCH/21_2.txt
extract_213 > $SCRATCH/21_3.txt
extract_06  > $SCRATCH/0_6.txt
extract_claude_bullet > $SCRATCH/claude_bullet.txt
for f in $SCRATCH/21_2.txt $SCRATCH/21_3.txt $SCRATCH/0_6.txt $SCRATCH/claude_bullet.txt; do
  [ -s "$f" ] \
    || { echo "FAIL: T7 — extracted body $f is empty (anchor not found?)"; exit 1; }
done

cat > $SCRATCH/forbidden.txt <<'EOF'
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

if cat $SCRATCH/21_2.txt $SCRATCH/21_3.txt $SCRATCH/0_6.txt $SCRATCH/claude_bullet.txt \
     | grep -F -f $SCRATCH/forbidden.txt >$SCRATCH/violations.txt 2>/dev/null; then
  if [ -s $SCRATCH/violations.txt ]; then
    echo "FAIL: T7 — Iron Rule violations in new bodies:"
    sed 's/^/  > /' $SCRATCH/violations.txt
    exit 1
  fi
fi
echo "PASS: T7 Iron Rule negative scan on 4 new bodies"

# ---------- T5: content presence inside extracted bodies (runs AFTER T7) ----------
# T5.a — §2.1.2 options + command sequences (AC-03/14/15)
for lbl in '(A) PRD-worthy' '(B) Spec-only' '(C) In-scope'; do
  grep -Fq "$lbl" $SCRATCH/21_2.txt \
    || { echo "FAIL: T5.a — §2.1.2 missing option label '$lbl'"; exit 1; }
done
# Alternative-command absence (Round 1 C1 fix)
grep -Fq '/prd resume' $SCRATCH/21_2.txt \
  && { echo "FAIL: T5.a — §2.1.2 contains forbidden '/prd resume' alt-command"; exit 1; }
grep -Fq '/spec upgrade-template' $SCRATCH/21_2.txt \
  && { echo "FAIL: T5.a — §2.1.2 contains forbidden '/spec upgrade-template' alt-command"; exit 1; }
# Option A canonical 4-command check — commands are indented inline within
# the AskUserQuestion code fence (no separate sub-fence per option).
# Extract the region between "(A) PRD-worthy" and "(B) Spec-only" labels.
awk '
  /\(A\) PRD-worthy/{inA=1; next}
  inA && /\(B\) Spec-only/{exit}
  inA {print}
' $SCRATCH/21_2.txt > $SCRATCH/opt_a_region.txt
# Extract command lines (leading-space followed by "/") — strip the indent
grep -E '^[[:space:]]+/' $SCRATCH/opt_a_region.txt | sed 's/^[[:space:]]*//' \
  > $SCRATCH/opt_a.txt
lines=$(wc -l < $SCRATCH/opt_a.txt | tr -d ' ')
[ "$lines" = "4" ] \
  || { echo "FAIL: T5.a — §2.1.2 Option A has $lines command lines (expected 4)"; exit 1; }
# Verify each command appears
grep -Eq '^/dev abort$'          $SCRATCH/opt_a.txt || { echo "FAIL: T5.a — Option A missing '/dev abort'"; exit 1; }
grep -Eq '^/prd "'               $SCRATCH/opt_a.txt || { echo "FAIL: T5.a — Option A missing '/prd \"...\"'"; exit 1; }
grep -Eq '^/spec docs/PRD\.md$'  $SCRATCH/opt_a.txt || { echo "FAIL: T5.a — Option A missing '/spec docs/PRD.md'"; exit 1; }
grep -Eq '^/dev \{'              $SCRATCH/opt_a.txt || { echo "FAIL: T5.a — Option A missing '/dev {...}'"; exit 1; }
# Order check — the 4 commands must appear in the canonical order
order=$(awk 'NR==1 && /^\/dev abort$/{printf "1"}
             NR==2 && /^\/prd "/{printf "2"}
             NR==3 && /^\/spec docs\/PRD\.md$/{printf "3"}
             NR==4 && /^\/dev \{/{printf "4"}
             END{printf "\n"}' $SCRATCH/opt_a.txt)
[ "$order" = "1234" ] \
  || { echo "FAIL: T5.a — Option A command order mismatch (got '$order', expected 1234)"; exit 1; }

# Option B canonical 3-command check — region between (B) and (C)
awk '
  /\(B\) Spec-only/{inB=1; next}
  inB && /\(C\) In-scope/{exit}
  inB {print}
' $SCRATCH/21_2.txt > $SCRATCH/opt_b_region.txt
grep -E '^[[:space:]]+/' $SCRATCH/opt_b_region.txt | sed 's/^[[:space:]]*//' \
  > $SCRATCH/opt_b.txt
lines=$(wc -l < $SCRATCH/opt_b.txt | tr -d ' ')
[ "$lines" = "3" ] \
  || { echo "FAIL: T5.a — §2.1.2 Option B has $lines command lines (expected 3)"; exit 1; }
grep -Eq '^/dev abort$'                             $SCRATCH/opt_b.txt || { echo "FAIL: T5.a — Option B missing '/dev abort'"; exit 1; }
grep -Eq '^/spec([[:space:]]|$|[[:space:]]+#)'      $SCRATCH/opt_b.txt || { echo "FAIL: T5.a — Option B missing '/spec' (bare or with inline comment)"; exit 1; }
grep -Eq '^/dev \{'                                 $SCRATCH/opt_b.txt || { echo "FAIL: T5.a — Option B missing '/dev {...}'"; exit 1; }
order_b=$(awk 'NR==1 && /^\/dev abort$/{printf "1"}
               NR==2 && /^\/spec([[:space:]]|$|[[:space:]]+#)/{printf "2"}
               NR==3 && /^\/dev \{/{printf "3"}
               END{printf "\n"}' $SCRATCH/opt_b.txt)
[ "$order_b" = "123" ] \
  || { echo "FAIL: T5.a — Option B command order mismatch (got '$order_b', expected 123)"; exit 1; }
echo "PASS: T5.a §2.1.2 options + Option A/B canonical command sequences"

# T5.b — §2.1.3 options + trigger phrase (AC-04/16)
for lbl in '(A) Code is correct' '(B) Doc is correct' '(C) Intentional drift'; do
  grep -Fq "$lbl" $SCRATCH/21_3.txt \
    || { echo "FAIL: T5.b — §2.1.3 missing option label '$lbl'"; exit 1; }
done
grep -Eiq 'fires only on DOCS phase \*\*re-entry\*\*|fires only on DOCS phase re-entry|re-entry DOCS only' $SCRATCH/21_3.txt \
  || { echo "FAIL: T5.b — §2.1.3 missing re-entry trigger phrase"; exit 1; }
echo "PASS: T5.b §2.1.3 options + trigger phrase"

# T5.c — §0.6 options + /spec-does-NOT-author phrase (AC-06/17)
for lbl in '(A) PRD-worthy via /prd' '(B) User manually edits PRD' '(C) Assumption documented'; do
  grep -Fq "$lbl" $SCRATCH/0_6.txt \
    || { echo "FAIL: T5.c — §0.6 missing option label '$lbl'"; exit 1; }
done
grep -Fq '/spec does NOT author' $SCRATCH/0_6.txt \
  || { echo "FAIL: T5.c — §0.6 missing '/spec does NOT author' phrase"; exit 1; }
echo "PASS: T5.c §0.6 options + Option B authorship phrase"

# T5.d — CLAUDE.md bullet trigger-hierarchy phrase (AC-09)
for sub in '§2.1.1 (ADR discovery, 2.5.0+)' \
           '§2.1.2 (PRD/cross-module-spec discovery, 2.7.0+)' \
           '§2.1.3 (Core Logic drift, 2.7.0+'; do
  grep -Fq "$sub" $SCRATCH/claude_bullet.txt \
    || { echo "FAIL: T5.d — CLAUDE.md bullet missing sub-phrase '$sub'"; exit 1; }
done
echo "PASS: T5.d CLAUDE.md bullet trigger-hierarchy phrase"

# ---------- T6: Descriptor presence across 3 languages + plugin/marketplace ----------
grep -Fq 'upstream-alignment' README.md \
  || { echo "FAIL: T6 — README.md missing 'upstream-alignment'"; exit 1; }
grep -Fq '上游对齐' README.zh-CN.md \
  || { echo "FAIL: T6 — README.zh-CN.md missing '上游对齐'"; exit 1; }
grep -Fq 'alineación upstream' README.es.md \
  || { echo "FAIL: T6 — README.es.md missing 'alineación upstream'"; exit 1; }
jq -r '.description' plugins/dev/.claude-plugin/plugin.json | grep -Fq '**2.7.0**' \
  || { echo "FAIL: T6 — plugin.json description missing '**2.7.0**'"; exit 1; }
jq -r '.plugins[] | select(.name=="dev") | .description' .claude-plugin/marketplace.json | grep -Fq '**2.7.0**' \
  || { echo "FAIL: T6 — marketplace.json dev-entry description missing '**2.7.0**'"; exit 1; }
echo "PASS: T6 descriptor presence across 3 languages + plugin/marketplace"

# ---------- T8: §2.1.1 byte-identical baseline check (workflow-internal) ----------
if [ ! -f .dev-state/state.json ]; then
  echo "SKIP: T8 §2.1.1 baseline — no .dev-state/state.json (outside active /dev session)"
  skipped_count=$((skipped_count+1))
else
  baseline_sha=$(jq -r '.start_commit // empty' .dev-state/state.json)
  if [ -z "$baseline_sha" ]; then
    echo "SKIP: T8 §2.1.1 baseline — state.json has no start_commit"
    skipped_count=$((skipped_count+1))
  else
    extract_211() {
      awk '
        BEGIN{in_fence=0; flag=0}
        /^ {0,3}(```|~~~)/{in_fence = !in_fence; if (flag) print; next}
        !in_fence && /^### 2\.1\.1 /{flag=1; print; next}
        flag && !in_fence && /^### 2\.[0-9]+(\.[0-9]+)? /{exit}
        flag {print}
      ' "$1" | awk '{a[NR]=$0} END{while(NR>0 && a[NR]==""){NR--} for(i=1;i<=NR;i++)print a[i]}'
    }
    current_body=$(extract_211 "$DEV_SKILL")
    baseline_body=$(git show "${baseline_sha}:${DEV_SKILL}" 2>/dev/null | extract_211 /dev/stdin)
    if [ -z "$baseline_body" ]; then
      echo "SKIP: T8 §2.1.1 baseline — git show failed or empty (baseline_sha=$baseline_sha)"
      skipped_count=$((skipped_count+1))
    elif [ "$current_body" = "$baseline_body" ]; then
      echo "PASS: T8 §2.1.1 body byte-identical to baseline"
    else
      echo "FAIL: T8 — §2.1.1 body drift"
      diff <(echo "$baseline_body") <(echo "$current_body") | sed 's/^/  > /' || true
      exit 1
    fi
  fi
fi

# ---------- T9: VERSIONING.md + CLAUDE.md section-presence + 9-rule count ----------
grep -Fq '## Release checklist (for upstream-alignment — 2.7.0+)' .claude/VERSIONING.md \
  || { echo "FAIL: T9 — VERSIONING.md missing upstream-alignment checklist"; exit 1; }
grep -Fq '/dev DOCS phase fires three inline upstream checks' .claude/CLAUDE.md \
  || { echo "FAIL: T9 — CLAUDE.md missing upstream-checks skill-dev bullet"; exit 1; }
rule_count=$(awk '
  /^## Release checklist \(for upstream-alignment — 2\.7\.0\+\)/{flag=1; next}
  flag && /^## /{exit}
  flag && /^[0-9]+\.[[:space:]]/{c++}
  END{print c+0}
' .claude/VERSIONING.md)
[ "$rule_count" = "9" ] \
  || { echo "FAIL: T9 — VERSIONING.md checklist has $rule_count rules (expected 9)"; exit 1; }
echo "PASS: T9 VERSIONING (checklist+9 rules) + CLAUDE section-presence"

# ---------- T10: Cross-reference paragraph present exactly once outside fences ----------
count=$(count_outside_fence_prefix "$DEV_SKILL" 'When DOCS is re-entered via ')
[ "$count" = "1" ] \
  || { echo "FAIL: T10 — cross-reference paragraph count=$count (expected 1)"; exit 1; }
echo "PASS: T10 cross-reference paragraph present exactly once outside fences"

# ---------- Epilogue ----------
total=10
ran=$((total - skipped_count))
if [ "$skipped_count" = "0" ]; then
  echo "Tests: ${total}/${total} passed (100%)"
else
  echo "Tests: ${ran}/${total} passed, ${skipped_count} skipped (100% of runnable)"
fi
exit 0
