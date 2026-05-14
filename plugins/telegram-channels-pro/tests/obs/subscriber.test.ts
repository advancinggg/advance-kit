import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { installObservability } from "../../src/obs";
import type { StateDir } from "../../src/daemon/state-dir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpLogDir(): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `tgcp-obs-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeFakeStateDir(logDir: string): StateDir {
  return {
    root: "/tmp/notused",
    lockFile: "",
    socketFile: "",
    adminFile: "",
    offsetFile: "",
    attachmentDir: "",
    logDir,
    async initialize() {},
  };
}

describe("MODULE-008-AC-01: subscribe to all canonical event types", () => {
  test("MODULE-008-T01 — emit each canonical event type → corresponding JSONL log line written", () => {
    const { dir, cleanup } = tmpLogDir();
    cleanups.push(cleanup);
    const eb = new EventBus();
    const clock = fakeClock(0);
    const obs = installObservability({
      eventBus: eb,
      deploymentMode: "lazy-spawn",
      clock,
      daemonPid: 1,
      daemonBootTs: 0,
    });
    cleanups.push(() => obs.dispose());
    obs.setStateDir(makeFakeStateDir(dir));
    // Emit a representative sample of events.
    eb.emit("daemon_start", { pid: 1, boot_ts: 0, bun_version: "1.0", deployment_mode: "lazy-spawn" });
    eb.emit("lock_event", { kind: "stale_takeover", stale_pid: 99 });
    eb.emit("polling_health", { ts: 0, state: "running" });
    eb.emit("session_connected", { session_id: "abcd", shortid: "s1", ts: 0 });
    eb.emit("state_dir_perms_anomaly", { path: "/x", expected: "0700", observed: "0755", action: "restored" });
    // Read log file content
    const logFile = path.join(dir, `daemon-${formatDate(new Date(0))}.jsonl`);
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toContain('"event_type":"daemon_start"');
    expect(content).toContain('"event_type":"lock_event"');
    expect(content).toContain('"event_type":"polling_health"');
    expect(content).toContain('"event_type":"session_connected"');
    expect(content).toContain('"event_type":"state_dir_perms_anomaly"');
  });
});

describe("MODULE-008-AC-16: subscriber_queue_drop logged as WARN", () => {
  test("MODULE-008-T16 — emit subscriber_queue_drop → log line at WARN level", () => {
    const { dir, cleanup } = tmpLogDir();
    cleanups.push(cleanup);
    const eb = new EventBus();
    const obs = installObservability({
      eventBus: eb,
      deploymentMode: "lazy-spawn",
      clock: fakeClock(0),
      daemonPid: 1,
      daemonBootTs: 0,
    });
    cleanups.push(() => obs.dispose());
    obs.setStateDir(makeFakeStateDir(dir));
    eb.emit("subscriber_queue_drop", { subscriber_id: "x", event_type: "polling_health", drop_count: 5 });
    const logFile = path.join(dir, `daemon-${formatDate(new Date(0))}.jsonl`);
    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toContain('"event_type":"subscriber_queue_drop"');
    expect(content).toContain('"level":"WARN"');
  });
});

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
