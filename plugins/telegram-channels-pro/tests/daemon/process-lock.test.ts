import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { acquireDaemonLock, releaseDaemonLock } from "../../src/daemon/process-lock";
import { E_LOCK_HELD_WRONG_BINARY } from "../../src/daemon/errors";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-001-AC-03/AC-04/AC-05/AC-19: file lock + stale takeover + binary identity", () => {
  test("MODULE-001-T04 — first daemon acquires lock with 0600 perms and PID content (AC-03 + AC-19)", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const handle = await acquireDaemonLock(tmp.stateDir, tmp.eventBus);
    expect(handle).not.toBeNull();
    cleanups.push(() => {
      void releaseDaemonLock(handle!);
    });
    const stat = fs.statSync(handle!.path);
    expect(stat.mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(handle!.path, "utf8");
    const lines = content.split("\n");
    expect(parseInt(lines[0]!, 10)).toBe(process.pid);
    expect(parseInt(lines[1]!, 10)).toBeGreaterThan(0); // boot_ts
    expect(lines[2]!.length).toBeGreaterThan(0); // bun version
  });

  test("MODULE-001-T05 — second daemon with matching live binary exits cleanly (lock_event: contention_exit)", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    // Write a lock file with pid = 1 and mock isProcessAlive + getProcessCommand to claim it's our daemon.
    fs.writeFileSync(tmp.stateDir.lockFile, `99998\n${Date.now()}\n1.0.0\n`, { mode: 0o600 });
    const collector = new EventCollector(tmp.eventBus);
    const handle = await acquireDaemonLock(tmp.stateDir, tmp.eventBus, {
      isProcessAlive: () => true,
      getProcessCommand: () => "/usr/bin/bun run telegram-channels-pro/bin/daemon.ts",
      selfPid: process.pid,
    });
    expect(handle).toBeNull();
    const contention = collector.byType("lock_event").filter((e) => (e.payload as { kind: string }).kind === "contention_exit");
    expect(contention.length).toBe(1);
    collector.stop();
  });

  test("MODULE-001-T06 — stale lock (dead PID) triggers takeover with lock_event: stale_takeover", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.lockFile, `99999\n${Date.now()}\n1.0.0\n`, { mode: 0o600 });
    const collector = new EventCollector(tmp.eventBus);
    const handle = await acquireDaemonLock(tmp.stateDir, tmp.eventBus, {
      isProcessAlive: () => false, // dead pid
      getProcessCommand: () => "",
      selfPid: process.pid,
    });
    expect(handle).not.toBeNull();
    cleanups.push(() => {
      void releaseDaemonLock(handle!);
    });
    const takeover = collector.byType("lock_event").filter((e) => (e.payload as { kind: string }).kind === "stale_takeover");
    expect(takeover.length).toBe(1);
    expect((takeover[0]!.payload as { stale_pid: number }).stale_pid).toBe(99999);
    collector.stop();
  });

  test("MODULE-001-T07 — live but wrong-binary lock throws E_LOCK_HELD_WRONG_BINARY", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.lockFile, `12345\n${Date.now()}\n1.0.0\n`, { mode: 0o600 });
    await expect(
      acquireDaemonLock(tmp.stateDir, tmp.eventBus, {
        isProcessAlive: () => true,
        getProcessCommand: () => "/usr/bin/sleep 60",
        selfPid: process.pid,
      }),
    ).rejects.toBeInstanceOf(E_LOCK_HELD_WRONG_BINARY);
  });

  test("MODULE-001-T19 — lock file written at 0600 (covered by T04 above but explicit assertion)", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const handle = await acquireDaemonLock(tmp.stateDir, tmp.eventBus);
    cleanups.push(() => {
      void releaseDaemonLock(handle!);
    });
    expect(fs.statSync(handle!.path).mode & 0o777).toBe(0o600);
  });
});
