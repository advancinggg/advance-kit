import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { EventBus } from "../../src/daemon/event-bus";
import { verifyFileOwnerAndMode } from "../../src/common/file-perms";
import { E_STATE_DIR_PERMS } from "../../src/daemon/errors";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-001-AC-20: uid mismatch on existing state file refuses operation", () => {
  test("MODULE-001-T21 — existing file with owner != process uid → throws E_STATE_DIR_PERMS + emits action='refused'", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.lockFile, "fake content", { mode: 0o600 });
    const originalGetUid = process.getuid;
    process.getuid = () => 999999;
    const collector = new EventCollector(tmp.eventBus);
    try {
      expect(() =>
        verifyFileOwnerAndMode(tmp.stateDir.lockFile, { expectedMode: 0o600, restoreOnOwnerMatch: true }, tmp.eventBus),
      ).toThrow(E_STATE_DIR_PERMS);
      const anomalies = collector.byType("state_dir_perms_anomaly");
      expect(anomalies.length).toBeGreaterThanOrEqual(1);
      expect((anomalies[0]!.payload as { action: string }).action).toBe("refused");
    } finally {
      process.getuid = originalGetUid;
      collector.stop();
    }
  });

  test("verifyFileOwnerAndMode same-uid with mismatched mode + restoreOnOwnerMatch=true → chmod restored + emits 'restored'", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.lockFile, "fake", { mode: 0o644 });
    fs.chmodSync(tmp.stateDir.lockFile, 0o644);
    const collector = new EventCollector(tmp.eventBus);
    const result = verifyFileOwnerAndMode(
      tmp.stateDir.lockFile,
      { expectedMode: 0o600, restoreOnOwnerMatch: true },
      tmp.eventBus,
    );
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(true);
    expect(fs.statSync(tmp.stateDir.lockFile).mode & 0o777).toBe(0o600);
    const anomalies = collector.byType("state_dir_perms_anomaly");
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect((anomalies[0]!.payload as { action: string }).action).toBe("restored");
    collector.stop();
  });
});
