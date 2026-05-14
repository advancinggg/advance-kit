import { describe, expect, test } from "bun:test";
import { fakeClock } from "../../src/daemon/clock";
import { StatusReporter } from "../../src/obs/status-reporter";

describe("MODULE-008-AC-13: StatusReporter.getSnapshot()", () => {
  test("MODULE-008-T13 — getSnapshot returns redacted struct with all fields populated (defaults for unknown)", () => {
    const clock = fakeClock(60_000);
    const sr = new StatusReporter(clock, "lazy-spawn", 0);
    const snap = sr.getSnapshot();
    expect(snap.uptime_seconds).toBe(60);
    expect(snap.deployment_mode).toBe("lazy-spawn");
    expect(snap.polling_state).toBe("running");
    expect(snap.quarantine_active).toBe(false);
    expect(snap.last_inbound_ts).toBeNull();
    expect(snap.registered_sessions).toBe(0);
    expect(snap.pending_approvals).toEqual({ current: 0, max: 50 });
    expect(snap.admin_source).toBe("none");
  });

  test("session_connected / session_disconnected updates registered_sessions cache", () => {
    const clock = fakeClock(0);
    const sr = new StatusReporter(clock, "lazy-spawn", 0);
    sr.sessionConnected();
    sr.sessionConnected();
    sr.sessionConnected();
    sr.sessionDisconnected();
    expect(sr.getSnapshot().registered_sessions).toBe(2);
  });

  test("setPollingState quarantine → quarantine_active=true", () => {
    const clock = fakeClock(0);
    const sr = new StatusReporter(clock, "launchd", 0);
    sr.setPollingState("quarantine");
    const snap = sr.getSnapshot();
    expect(snap.polling_state).toBe("quarantine");
    expect(snap.quarantine_active).toBe(true);
  });
});
