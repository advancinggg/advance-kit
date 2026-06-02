#!/usr/bin/env bash
# dev-version-banner.sh — print the dev-plugin template version + warn on session↔installed drift.
#
# READ-ONLY, side-effect-free, ALWAYS exits 0 (never blocks the calling skill).
#
# Usage: dev-version-banner.sh <skill-label> <session-bound-version>
#   <skill-label>            display label (spec | prd | dev)
#   <session-bound-version>  the version literal baked into the calling SKILL.md = what THIS
#                            loaded session is actually running. Compared against the on-disk
#                            plugin.json version (what is INSTALLED). If installed > bound, the
#                            loaded skill is stale (a newer plugin was installed mid-session) →
#                            prominent restart/reload warning.
#
# Arg interface FROZEN (K1 / VERSIONING Hard rule 1 + "version-drift visibility" checklist).
# Reorder/rename the two positional args ⇒ MAJOR dev bump (old SKILL.md call sites break).
set -u

skill="${1:-dev}"
bound="${2:-unknown}"
pj="${CLAUDE_PLUGIN_ROOT:-}/.claude-plugin/plugin.json"

# Primary path: python3 reads plugin.json AND does a numeric (semver-correct) compare in one
# pass. python3 is a hard plugin dependency (see check-phase.sh fail-close), and a numeric
# tuple compare avoids both the `2.9 vs 2.10` model-arithmetic trap and the non-portable
# `sort -V` BSD hazard flagged in K8.
if command -v python3 >/dev/null 2>&1 && python3 - "$skill" "$bound" "$pj" 2>/dev/null <<'PY'
import json, sys
skill, bound, pj = sys.argv[1], sys.argv[2], sys.argv[3]
def tup(v):
    try:
        return tuple(int(x) for x in str(v).strip().split("."))
    except Exception:
        return None
try:
    installed = json.load(open(pj)).get("version")
except Exception:
    installed = None
b, i = tup(bound), tup(installed)
if b is None or i is None:
    print(f"[dev v{bound}] /{skill} running against template v{bound} (installed version unknown — dev/repo mode)")
elif i == b:
    print(f"[dev v{bound}] /{skill} running against the installed template (current)")
elif i > b:
    bar = "=" * 64
    print(bar)
    print("  !!  DEV TEMPLATE VERSION DRIFT")
    print(f"  This session is running dev template v{bound}, but v{installed} is INSTALLED on disk.")
    print(f"  -> Restart Claude Code (or /reload-skills, then re-invoke /{skill}) to load v{installed}.")
    print(f"     Continuing on v{bound} for this run.")
    print(bar)
else:
    print(f"[dev v{bound}] /{skill} running against template v{bound} (installed v{installed} is older — local dev)")
PY
then
  exit 0
fi

# Fallback: python3 missing or errored (rare — python3 is a hard plugin dep). Print the
# session-bound version without drift detection rather than failing the calling skill.
echo "[dev v${bound}] /${skill} running against template v${bound} (drift detection unavailable)"
exit 0
