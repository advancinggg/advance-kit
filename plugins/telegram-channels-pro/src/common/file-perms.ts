import * as fs from "node:fs";
import type { EventBus } from "../daemon/event-bus";
import { E_STATE_DIR_PERMS } from "../daemon/errors";

export interface VerifyOptions {
  /** Expected mode bits (e.g., 0o600 for files, 0o700 for dirs). */
  expectedMode: number;
  /** If true and owner matches process uid, chmod to expected; else throw. */
  restoreOnOwnerMatch: boolean;
}

export interface VerifyResult {
  /** True if path was at expected mode/owner from the start. */
  ok: boolean;
  /** Restored to expected mode (same-uid mismatched mode → chmod). */
  restored: boolean;
}

/**
 * Verify file owner == process uid AND mode bits == expected.
 * If owner matches AND mode differs AND restoreOnOwnerMatch is true → chmod + emit
 * `state_dir_perms_anomaly{action:'restored'}` + return restored:true.
 * If owner mismatch (any mode) → throw E_STATE_DIR_PERMS + emit `{action:'refused'}`.
 * If file does not exist → return {ok:true, restored:false}.
 */
export function verifyFileOwnerAndMode(absPath: string, opts: VerifyOptions, eventBus: EventBus): VerifyResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, restored: false };
    }
    throw err;
  }
  const selfUid = process.getuid ? process.getuid() : -1;
  const observedMode = stat.mode & 0o777;
  const expectedMode = opts.expectedMode;
  if (stat.uid !== selfUid) {
    eventBus.emit("state_dir_perms_anomaly", {
      path: absPath,
      expected: "0" + expectedMode.toString(8),
      observed: "0" + observedMode.toString(8),
      action: "refused",
    });
    throw new E_STATE_DIR_PERMS(absPath, observedMode, expectedMode, stat.uid, selfUid);
  }
  if (observedMode === expectedMode) {
    return { ok: true, restored: false };
  }
  if (!opts.restoreOnOwnerMatch) {
    eventBus.emit("state_dir_perms_anomaly", {
      path: absPath,
      expected: "0" + expectedMode.toString(8),
      observed: "0" + observedMode.toString(8),
      action: "refused",
    });
    throw new E_STATE_DIR_PERMS(absPath, observedMode, expectedMode, stat.uid, selfUid);
  }
  fs.chmodSync(absPath, expectedMode);
  eventBus.emit("state_dir_perms_anomaly", {
    path: absPath,
    expected: "0" + expectedMode.toString(8),
    observed: "0" + observedMode.toString(8),
    action: "restored",
  });
  return { ok: true, restored: true };
}
