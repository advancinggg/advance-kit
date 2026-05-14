import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock, realClock } from "../../src/daemon/clock";
import { ControlSocket } from "../../src/deployment/control-socket";
import { StatusReporter } from "../../src/obs/status-reporter";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* ignore */ }
  }
});

function sendOneFrame(socketPath: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: socketPath });
    let buf = "";
    sock.setEncoding("utf-8");
    sock.on("connect", () => {
      sock.write(frame + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.end();
        resolve(buf.slice(0, nl));
      }
    });
    sock.on("error", reject);
    sock.on("close", () => {
      if (buf.length > 0 && !buf.includes("\n")) resolve(buf);
    });
  });
}

describe("MODULE-007-AC-08: status_request via ControlSocket", () => {
  test("MODULE-007-T08 — start ControlSocket; send status_request; receive snapshot", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const sr = new StatusReporter(realClock(), "lazy-spawn", Date.now());
    sr.sessionConnected();
    sr.sessionConnected();
    sr.setPendingCapacity(2, 50);
    sr.setAdminSource("env");
    let resetCalled = false;
    const ctl = new ControlSocket({
      stateDir: tmp.stateDir,
      eventBus: tmp.eventBus,
      clock: realClock(),
      deploymentMode: "lazy-spawn",
      getSnapshot: () => sr.getSnapshot(),
      resetAdmin: () => {
        resetCalled = true;
        return { cleared: true, prior_admin_hash: "abc", deployment_mode: "lazy-spawn", daemon_pid: 12345 };
      },
    });
    await ctl.start();
    cleanups.push(() => ctl.stop());
    const responseLine = await sendOneFrame(tmp.stateDir.controlSocketFile, JSON.stringify({ kind: "status_request" }));
    const resp = JSON.parse(responseLine);
    expect(resp.ok).toBe(true);
    expect(resp.result.deployment_mode).toBe("lazy-spawn");
    expect(resp.result.registered_sessions).toBe(2);
    expect(resp.result.pending_approvals).toEqual({ current: 2, max: 50 });
    expect(resp.result.admin_source).toBe("env");
    // Verify socket perms 0600
    const stat = fs.statSync(tmp.stateDir.controlSocketFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(resetCalled).toBe(false);
  });
});

describe("MODULE-007-AC-07: reset_admin_request via ControlSocket", () => {
  test("MODULE-007-T07 — start ControlSocket; send reset_admin_request; resetAdmin invoked; response includes deployment_mode + daemon_pid", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    let resetCalled = false;
    const ctl = new ControlSocket({
      stateDir: tmp.stateDir,
      eventBus: tmp.eventBus,
      clock: realClock(),
      deploymentMode: "launchd",
      getSnapshot: () => ({
        uptime_seconds: 0,
        deployment_mode: "launchd",
        polling_state: "running",
        quarantine_active: false,
        last_inbound_ts: null,
        registered_sessions: 0,
        pending_approvals: { current: 0, max: 50 },
        admin_source: "none",
      }),
      resetAdmin: () => {
        resetCalled = true;
        return { cleared: true, prior_admin_hash: "deadbeef", deployment_mode: "launchd", daemon_pid: 99 };
      },
    });
    await ctl.start();
    cleanups.push(() => ctl.stop());
    const responseLine = await sendOneFrame(tmp.stateDir.controlSocketFile, JSON.stringify({ kind: "reset_admin_request" }));
    const resp = JSON.parse(responseLine);
    expect(resp.ok).toBe(true);
    expect(resp.result.cleared).toBe(true);
    expect(resp.result.prior_admin_hash).toBe("deadbeef");
    expect(resp.result.deployment_mode).toBe("launchd");
    expect(resp.result.daemon_pid).toBe(99);
    expect(resetCalled).toBe(true);
  });
});

describe("ControlSocket: malformed JSON returns error", () => {
  test("malformed input → ok:false response", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const ctl = new ControlSocket({
      stateDir: tmp.stateDir,
      eventBus: tmp.eventBus,
      clock: realClock(),
      deploymentMode: "lazy-spawn",
      getSnapshot: () => ({
        uptime_seconds: 0,
        deployment_mode: "lazy-spawn",
        polling_state: "running",
        quarantine_active: false,
        last_inbound_ts: null,
        registered_sessions: 0,
        pending_approvals: { current: 0, max: 50 },
        admin_source: "none",
      }),
      resetAdmin: () => ({ cleared: false, prior_admin_hash: null, deployment_mode: "lazy-spawn", daemon_pid: 1 }),
    });
    await ctl.start();
    cleanups.push(() => ctl.stop());
    const r = await sendOneFrame(tmp.stateDir.controlSocketFile, "not-json");
    const resp = JSON.parse(r);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("malformed_json");
  });
});
