import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { EventBus } from "../../src/daemon/event-bus";
import { E_STATE_DIR_PERMS } from "../../src/daemon/errors";
import { StateDirImpl } from "../../src/daemon/state-dir";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-001-AC-01: StateDir initialization creates 0700 directory at the Apple Application Support path", () => {
  test("MODULE-001-T01 — state dir missing → created at mode 0700", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    expect(fs.existsSync(tmp.root)).toBe(false);
    await tmp.stateDir.initialize();
    expect(fs.existsSync(tmp.root)).toBe(true);
    const stat = fs.statSync(tmp.root);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(fs.existsSync(tmp.logDir)).toBe(true);
    expect(fs.statSync(tmp.logDir).mode & 0o777).toBe(0o700);
  });
});

describe("MODULE-001-AC-02: perms anomaly handling", () => {
  test("MODULE-001-T02 — state dir 0755 + same uid → chmod-restored to 0700 + emit state_dir_perms_anomaly action=restored", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    fs.mkdirSync(tmp.root, { recursive: true });
    fs.chmodSync(tmp.root, 0o755);
    const collector = new EventCollector(tmp.eventBus);
    await tmp.stateDir.initialize();
    expect(fs.statSync(tmp.root).mode & 0o777).toBe(0o700);
    const anomalies = collector.byType("state_dir_perms_anomaly");
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect((anomalies[0]!.payload as { action: string }).action).toBe("restored");
    collector.stop();
  });

  test("MODULE-001-T03 — state dir 0755 + different uid → throws E_STATE_DIR_PERMS + emit action=refused", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    fs.mkdirSync(tmp.root, { recursive: true });
    fs.chmodSync(tmp.root, 0o755);
    // Mock process.getuid to return a different uid than the file's owner.
    const originalGetUid = process.getuid;
    process.getuid = () => 999999; // arbitrary uid not matching the file's owner
    const collector = new EventCollector(tmp.eventBus);
    try {
      await expect(tmp.stateDir.initialize()).rejects.toBeInstanceOf(E_STATE_DIR_PERMS);
      const anomalies = collector.byType("state_dir_perms_anomaly");
      expect(anomalies.length).toBeGreaterThanOrEqual(1);
      expect((anomalies[0]!.payload as { action: string }).action).toBe("refused");
    } finally {
      process.getuid = originalGetUid;
      collector.stop();
    }
  });
});
