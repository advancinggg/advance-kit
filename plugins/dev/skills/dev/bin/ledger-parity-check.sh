#!/usr/bin/env bash
# ledger-parity-check.sh — §1.5↔§3.4 DOCS-exit parity gate (3.8.0+)
#
# Asserts that every Acceptance Criterion declared in a touched MODULE doc's §1.5
# has a matching row in that doc's §3.4 ledger (set(§1.5 AC-IDs) ⊆ set(§3.4 AC-IDs)).
# This is the mechanical backstop for the 3.7.0 "DOCS births §3.4 rows" invariant:
# it stops a /dev run from leaving DOCS with a row-pending AC (the desync/over-claim
# class).
#
# Args:  $1 = STATE_FILE   $2 = REPO_ROOT (resolved)
# Exit:  0 = parity OK, OR indeterminate  (FAIL-OPEN — never block on ambiguity)
#        2 = CONFIRMED desync; stdout lists "MODULE-file.md: AC-ID, AC-ID, ..."
#
# This is a CORRECTNESS gate, not a security gate. Unlike check-phase.sh (which
# fails CLOSED for security), every parse error / missing file / unknown shape here
# resolves to ALLOW, so a formatting quirk can never hard-block a /dev run. The
# remaining safety nets — the SUMMARY fail-closed denominator, the §6.1.1 parity
# assertion, and /spec's terminal self-heal — still catch anything this gate lets by.
set -uo pipefail   # intentionally NOT -e: continue past sub-failures and fail-open

STATE_FILE="${1:-}"
REPO="${2:-}"

[ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ] || exit 0
command -v jq      >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# Lightweight mode has no §3.4 ledger at all → nothing to check.
# NB: `.sdd_mode // true` is WRONG here — jq's // treats boolean false as empty and
# would yield true. Test the literal instead so sdd_mode:false short-circuits.
SDD=$(jq -r 'if .sdd_mode == false then "false" else "true" end' "$STATE_FILE" 2>/dev/null) || SDD=true
[ "$SDD" = "false" ] && exit 0

python3 - "$STATE_FILE" "$REPO" <<'PY'
import json, os, re, sys

state_file, repo = sys.argv[1], sys.argv[2]

try:
    st = json.load(open(state_file))
except Exception:
    sys.exit(0)  # unreadable state → fail-open

# ── Scope: only modules THIS run touched (never blame untouched legacy desync) ──
# Source 1: docs_allowlist entries that point at a module doc.
# Source 2: the MODULE-NNN prefixes of in_scope_ac_ids.
allow_basenames = set()
for p in (st.get("docs_allowlist") or []):
    p = str(p)
    if re.search(r'modules/MODULE-\d+', p):
        allow_basenames.add(os.path.basename(p))

ac_prefixes = set()
for ac in (st.get("in_scope_ac_ids") or []):
    m = re.match(r'(MODULE-\d+)', str(ac))
    if m:
        ac_prefixes.add(m.group(1))

mod_dir = os.path.join(repo, "docs", "modules")
files = []
if os.path.isdir(mod_dir):
    for fn in sorted(os.listdir(mod_dir)):
        if not fn.endswith(".md"):
            continue
        fpref = re.match(r'(MODULE-\d+)', fn)
        in_scope = (fn in allow_basenames) or bool(fpref and fpref.group(1) in ac_prefixes)
        if in_scope:
            files.append(os.path.join(mod_dir, fn))

if not files:
    sys.exit(0)  # nothing in scope → fail-open


def section(text, num):
    """Body of '### {num} ...' up to the next '### ' heading (any depth-3)."""
    pat = re.compile(r'^###\s+' + re.escape(num) + r'(?:\s|$)')
    out, capture = [], False
    for ln in text.splitlines():
        if ln.startswith('### '):
            if capture:
                break
            if pat.match(ln):
                capture = True
            continue
        if capture:
            out.append(ln)
    return "\n".join(out)


def first_col_ac_ids(sec_text):
    """AC-IDs sitting in column 1 of a markdown table row (the declaration cell)."""
    ids = set()
    for ln in sec_text.splitlines():
        s = ln.strip()
        if not s.startswith('|'):
            continue
        cells = [c.strip() for c in s.strip('|').split('|')]
        if cells and re.fullmatch(r'MODULE-\d+-AC-\d+', cells[0]):
            ids.add(cells[0])
    return ids


desync = []
for f in files:
    try:
        txt = open(f).read()
    except Exception:
        continue  # unreadable file → fail-open for this module
    set15 = first_col_ac_ids(section(txt, "1.5"))
    set34 = first_col_ac_ids(section(txt, "3.4"))
    if not set15:
        continue  # could not parse a §1.5 declaration → fail-open for this module
    orphans = sorted(set15 - set34)
    if orphans:
        desync.append((os.path.basename(f), orphans))

if desync:
    for fn, orphans in desync:
        print(f"{fn}: {', '.join(orphans)}")
    sys.exit(2)

sys.exit(0)
PY
