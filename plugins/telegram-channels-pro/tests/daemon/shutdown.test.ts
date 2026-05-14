import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { acquireDaemonLock } from "../../src/daemon/process-lock";
import { installShutdownHandlers, cleanupStaleSocket } from "../../src/daemon/shutdown";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-001-AC-06: SIGTERM graceful shutdown", () => {
  test("MODULE-001-T08 — requestShutdown emits daemon_stop + releases lock + unlinks socket + exits 0", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const handle = await acquireDaemonLock(tmp.stateDir, tmp.eventBus);
    expect(handle).not.toBeNull();
    // Touch the socket file so cleanup can verify unlink.
    fs.writeFileSync(tmp.stateDir.socketFile, "", { mode: 0o600 });
    let exitCode: number | null = null;
    const collector = new EventCollector(tmp.eventBus);
    const ctl = installShutdownHandlers({
      eventBus: tmp.eventBus,
      lockHandle: handle!,
      stateDir: tmp.stateDir,
      bootTs: Date.now() - 1234,
      exitFn: (code) => {
        exitCode = code;
      },
      flushBarrierMs: 10,
    });
    await ctl.requestShutdown("test_shutdown", 0);
    expect(exitCode).toBe(0);
    const stops = collector.byType("daemon_stop");
    expect(stops.length).toBe(1);
    expect((stops[0]!.payload as { reason: string }).reason).toBe("test_shutdown");
    expect((stops[0]!.payload as { uptime_ms: number }).uptime_ms).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(tmp.stateDir.lockFile)).toBe(false);
    expect(fs.existsSync(tmp.stateDir.socketFile)).toBe(false);
    ctl.uninstall();
    collector.stop();
  });
});

describe("MODULE-001-AC-17: offset.json preserved across daemon shutdown cycle", () => {
  test("MODULE-001-T18 — offset.json contents untouched after SIGTERM (M001 doesn't modify offset)", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    // Pre-seed offset.json with a known value (M002 owns this file's content; M001 should not touch it).
    fs.writeFileSync(tmp.stateDir.offsetFile, JSON.stringify({ offset: 12345, ts: 1000 }), { mode: 0o600 });
    const handle = await acquireDaemonLock(tmp.stateDir, tmp.eventBus);
    let exitCode: number | null = null;
    const ctl = installShutdownHandlers({
      eventBus: tmp.eventBus,
      lockHandle: handle!,
      stateDir: tmp.stateDir,
      bootTs: Date.now() - 100,
      exitFn: (code) => {
        exitCode = code;
      },
      flushBarrierMs: 10,
    });
    await ctl.requestShutdown("graceful", 0);
    expect(exitCode).toBe(0);
    // offset.json contents preserved
    const preserved = JSON.parse(fs.readFileSync(tmp.stateDir.offsetFile, "utf8"));
    expect(preserved.offset).toBe(12345);
    expect(preserved.ts).toBe(1000);
    ctl.uninstall();
  });
});

describe("MODULE-001-AC-21: stale socket cleanup on boot", () => {
  test("MODULE-001-T22 — dangling socket file with no listener → cleanupStaleSocket unlinks", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    // Create a regular file at the socket path to simulate a dangling socket (connect() will refuse).
    fs.writeFileSync(tmp.stateDir.socketFile, "");
    const res = await cleanupStaleSocket(tmp.stateDir.socketFile);
    expect(res.cleaned).toBe(true);
    expect(res.reason).toBe("stale_unlinked");
    expect(fs.existsSync(tmp.stateDir.socketFile)).toBe(false);
  });

  test("cleanupStaleSocket with missing socket returns cleaned=false reason='missing'", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const res = await cleanupStaleSocket(tmp.stateDir.socketFile);
    expect(res.cleaned).toBe(false);
    expect(res.reason).toBe("missing");
  });
});
