import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fakeClock, realClock } from "../../src/daemon/clock";
import { JsonLogger } from "../../src/obs/json-logger";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpLogDir(): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `tgcp-log-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("MODULE-008-AC-02: log file path + 0600 perms", () => {
  test("MODULE-008-T02 — log file written to <log_dir>/daemon-YYYYMMDD.jsonl with 0600 perms", () => {
    const { dir, cleanup } = tmpLogDir();
    cleanups.push(cleanup);
    const logger = new JsonLogger({ logDir: dir, clock: realClock() });
    cleanups.push(() => logger.stop());
    logger.start();
    logger.append({ ts: Date.now(), level: "INFO", event_type: "daemon_start", pid: 1 });
    const filePath = logger.getCurrentFile();
    expect(fs.existsSync(filePath)).toBe(true);
    expect(/daemon-\d{8}\.jsonl$/.test(filePath)).toBe(true);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

describe("MODULE-008-AC-03: rotation on size > 50 MB", () => {
  test("MODULE-008-T03 — file size > maxFileBytes triggers roll to a numbered suffix", () => {
    const { dir, cleanup } = tmpLogDir();
    cleanups.push(cleanup);
    // Use a small cap and write enough to force at least one roll.
    const logger = new JsonLogger({ logDir: dir, clock: realClock(), maxFileBytes: 500 });
    cleanups.push(() => logger.stop());
    logger.start();
    for (let i = 0; i < 30; i++) {
      logger.append({ ts: Date.now(), level: "INFO", event_type: "test", padding: "x".repeat(50) });
    }
    expect(logger.lastRotation).not.toBeNull();
    expect(/-\d+\.jsonl$/.test(logger.lastRotation!.newFile)).toBe(true);
  });
});

describe("MODULE-008-AC-17: retention janitor unlinks files older than 14 days", () => {
  test("MODULE-008-T17 — runJanitor() removes log files with mtime > 14 days old", () => {
    const { dir, cleanup } = tmpLogDir();
    cleanups.push(cleanup);
    const clock = fakeClock(1_000_000_000_000); // arbitrary base ts
    const oldFile = path.join(dir, "daemon-20260101.jsonl");
    fs.writeFileSync(oldFile, "old\n", { mode: 0o600 });
    // Set mtime to 20 days before clock.now()
    const oldMtime = (1_000_000_000_000 - 20 * 24 * 60 * 60_000) / 1000;
    fs.utimesSync(oldFile, oldMtime, oldMtime);
    const recentFile = path.join(dir, "daemon-20260514.jsonl");
    fs.writeFileSync(recentFile, "recent\n", { mode: 0o600 });
    const logger = new JsonLogger({ logDir: dir, clock, retentionDays: 14 });
    cleanups.push(() => logger.stop());
    const res = logger.runJanitor();
    expect(res.unlinkedCount).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });
});

describe("MODULE-008-AC-18: log directory 0700 + log files 0600", () => {
  test("MODULE-008-T18 — log dir tmp set at 0700 + each appended file at 0600", () => {
    const { dir, cleanup } = tmpLogDir();
    cleanups.push(cleanup);
    fs.chmodSync(dir, 0o700);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const logger = new JsonLogger({ logDir: dir, clock: realClock() });
    cleanups.push(() => logger.stop());
    logger.start();
    logger.append({ ts: Date.now(), level: "INFO", event_type: "x" });
    expect(fs.statSync(logger.getCurrentFile()).mode & 0o777).toBe(0o600);
  });
});
