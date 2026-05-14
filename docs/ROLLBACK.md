# Rollback Plan — telegram-channels-pro v0.1.0

> Purpose: when telegram-channels-pro v0.1.0 produces serious user-facing problems
> in production, this document describes when to roll back to the upstream
> `external_plugins/telegram` plugin (or a previous advance-kit release), what to
> capture beforehand, and the exact step sequence.

---

## Rollback triggers

Roll back if **any one** of the following criteria is observed within a 72h
production window (from PRD §7):

1. **Inbound silent-failure**: ≥1 inbound TG message that did not reach any
   registered claude session AND the daemon did not auto-heal within 5 minutes
   (no quarantine_exit + no successful deliverToSession for the same update_id
   within the window). Surfaced via M008 Subscriber log search:
   `grep '"event_type":"inbound_update"' daemon-*.jsonl | jq 'select(.update_id ==
   N)'` cross-referenced with the M005 `route_decision` events for the same
   update_id.

2. **Cross-process SIGTERM**: any non-daemon process was sent a SIGTERM by the
   M001 watchdog or by the M001 file-lock contention path. This is the RC#2
   "self-aware lifecycle" invariant — if it ever fires, the binary-identity
   validation has a bug. Surfaced via M008 Subscriber log search:
   `grep '"event_type":"watchdog_signal"' daemon-*.jsonl` and
   `grep '"event_type":"lock_event"' daemon-*.jsonl`.

3. **Approval round-trip failures**: ≥3 `request_approval` requests in 24h that
   resulted in admin-clicked-button but claude-side did NOT receive the resolution
   (approver clicked but session never got the choice string). Surfaced via cross-
   reference of M005 `route_decision: callback_resolved` events vs the resulting
   M004 tool_result events.

If none of (1)/(2)/(3) fire but you suspect intermittent issues, prefer
investigation (open an issue with diagnostic capture per below) over rollback —
v0.1.0 is the infrastructure baseline, and downgrading invalidates future fix
data.

---

## Diagnostic steps (BEFORE rollback)

Capture the following so the rollback can be debriefed:

1. **Status snapshot**: run `/telegram-channels-pro:status` and save output to a
   timestamped file. The snapshot includes: uptime, polling_state,
   quarantine_active, last_inbound_ts, registered_sessions, pending_approvals,
   admin_source.

2. **Log archive**: copy the last 24h of daemon JSONL logs from
   `~/Library/Logs/advance-kit/telegram-channels-pro/daemon-*.jsonl` and the last
   24h of stderr from `~/Library/Logs/advance-kit/telegram-channels-pro/daemon.err`.
   Use `tar czvf telegram-channels-pro-rollback-debrief-$(date +%Y%m%d%H%M%S).tar.gz
   ~/Library/Logs/advance-kit/telegram-channels-pro/` to bundle.

3. **State directory snapshot** (only if rollback will REMOVE state): copy
   `~/Library/Application\ Support/advance-kit/telegram-channels-pro/admin.json`
   and `offset.json` to a safe location. The state directory contains user-
   identifying data (admin TG user_id) and the polling offset.

4. **Marketplace + plugin metadata**: capture
   `~/.claude/plugins/installed_plugins.json` to know which version is currently
   installed.

5. **GitHub issue**: open an issue at the advance-kit repo with the trigger
   criterion (1/2/3) and attach the bundle from step 2.

---

## Execution steps

Execute in order:

1. **Uninstall the daemon**:
   ```
   /telegram-channels-pro:uninstall-daemon
   ```
   When prompted "Also remove state directory? (y/n)":
   - Choose **y** if you want a clean state for the rollback target
     (recommended — state from v0.1.0 may not be readable by upstream).
   - Choose **n** if you intend to reinstall v0.1.0 later and want to preserve
     admin allowlist + offset.json.

2. **Remove the marketplace entry**:
   Edit `~/.claude/plugins/marketplaces/advance-kit/.claude-plugin/marketplace.json`
   (or wherever advance-kit is checked out) and remove the
   `telegram-channels-pro` entry from the `plugins` array. Save.

3. **Reload the claude plugin marketplace**:
   ```
   /reload-plugins
   ```
   Verify the plugin no longer appears in `claude /plugins` output.

4. **Install upstream replacement**:
   Follow upstream `external_plugins/telegram` install instructions:
   ```
   claude /plugin install telegram@anthropics
   ```
   (Or whatever the current upstream install incantation is.)

5. **Restart claude sessions**:
   Quit and relaunch any active claude sessions so they pick up the new plugin
   set. New sessions invoking `--channels telegram` will use the upstream
   handler.

6. **Verify recovery**: send a TG DM to the bot. Confirm the upstream plugin
   responds (this validates the bot token + admin allowlist are intact and
   the rollback succeeded).

---

## Version revert (advance-kit-level)

If you want to revert to a prior advance-kit release without changing
telegram-channels-pro specifically:

1. `cd <advance-kit checkout>`
2. `git log --oneline plugins/telegram-channels-pro/` to find the last
   pre-v0.1.0 commit (likely the `docs(telegram-channels-pro): add architecture
   and module specs` commit before any `dev(tgcp-*): ...` implementation
   commits).
3. `git revert <commit-range>` for the implementation commits, OR `git checkout
   <pre-impl-commit>` for a hard revert.
4. `/reload-plugins` in claude to pick up the reverted state.

Note: a full git revert is destructive; prefer `/telegram-channels-pro:uninstall-daemon`
+ marketplace edit (steps 1-3 above) for a non-destructive rollback that
preserves the advance-kit checkout for future re-attempts.

---

## Post-rollback follow-up

1. File a GitHub issue with the diagnostic bundle from §Diagnostic Steps.
2. Wait for upstream-fix release OR an advance-kit re-release with the issue
   addressed.
3. To re-attempt v0.1.0 after a fix:
   - Re-add `telegram-channels-pro` entry to `marketplace.json`.
   - `/reload-plugins`.
   - `/telegram-channels-pro:install-daemon` — choose `y` for launchd auto-start
     (or `n` for lazy-spawn).
   - If state directory was preserved (uninstall step 1 chose `n`), the daemon
     will boot with the prior admin allowlist + offset; otherwise the
     registration-window flow re-runs (per MODULE-006 §1.4.5).
