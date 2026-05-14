import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { Watchdog } from "../../src/daemon/watchdog";
import { EventCollector } from "../helpers/event-collector";

describe("MODULE-001-AC-11/AC-12/AC-13/AC-14: Watchdog probe loop", () => {
  test("MODULE-001-T13 — orphan detection emits watchdog_signal:orphan with severity=failure", () => {
    const eb = new EventBus();
    const fc = fakeClock(0);
    let currentPpid = 100;
    let shutdownReason: string | null = null;
    const wd = new Watchdog({
      eventBus: eb,
      clock: fc,
      deploymentMode: "lazy-spawn",
      bootPpid: 100,
      getCurrentPpid: () => currentPpid,
      requestShutdown: (r) => {
        shutdownReason = r;
      },
      heartbeatTimeoutMs: 999_999, // disable stuck detection during this test
    });
    const collector = new EventCollector(eb);
    wd.start();
    // Simulate parent disappearance.
    currentPpid = 999;
    wd.probeOnce();
    const sig = collector.byType("watchdog_signal");
    expect(sig.length).toBe(1);
    expect((sig[0]!.payload as { kind: string }).kind).toBe("orphan");
    expect((sig[0]!.payload as { severity: string }).severity).toBe("failure");
    // alert_emit fires BEFORE watchdog_signal (AC-14)
    const seq = collector.events.filter((e) => e.type === "alert_emit" || e.type === "watchdog_signal");
    expect(seq.length).toBe(2);
    expect(seq[0]!.type).toBe("alert_emit");
    expect(seq[1]!.type).toBe("watchdog_signal");
    expect(shutdownReason).toBe("watchdog:orphan");
    wd.stop();
    collector.stop();
  });

  test("MODULE-001-T14 — stuck detection after >60s without polling_health (severity=failure)", () => {
    const eb = new EventBus();
    const fc = fakeClock(0);
    let shutdownReason: string | null = null;
    const wd = new Watchdog({
      eventBus: eb,
      clock: fc,
      deploymentMode: "lazy-spawn",
      bootPpid: 100,
      getCurrentPpid: () => 100,
      requestShutdown: (r) => {
        shutdownReason = r;
      },
    });
    const collector = new EventCollector(eb);
    wd.start();
    // Advance time past 60s without emitting polling_health.
    fc.tick(70_000);
    const sig = collector.byType("watchdog_signal");
    expect(sig.length).toBe(1);
    expect((sig[0]!.payload as { kind: string }).kind).toBe("stuck");
    expect((sig[0]!.payload as { severity: string }).severity).toBe("failure");
    // alert_emit BEFORE watchdog_signal
    const alertFirst = collector.events.findIndex((e) => e.type === "alert_emit");
    const sigIdx = collector.events.findIndex((e) => e.type === "watchdog_signal");
    expect(alertFirst).toBeGreaterThanOrEqual(0);
    expect(alertFirst).toBeLessThan(sigIdx);
    expect(shutdownReason).toBe("watchdog:stuck");
    wd.stop();
    collector.stop();
  });

  test("MODULE-001-T15 — idle detection in lazy-spawn after 30min with 0 clients (severity=normal, NO alert)", () => {
    const eb = new EventBus();
    const fc = fakeClock(0);
    let shutdownReason: string | null = null;
    const wd = new Watchdog({
      eventBus: eb,
      clock: fc,
      deploymentMode: "lazy-spawn",
      bootPpid: 100,
      getCurrentPpid: () => 100,
      requestShutdown: (r) => {
        shutdownReason = r;
      },
      heartbeatTimeoutMs: 999_999_999, // disable stuck
    });
    const collector = new EventCollector(eb);
    wd.start();
    fc.tick(31 * 60_000);
    // Need polling_health regularly to avoid stuck path; emit it during idle period:
    // Actually the watchdog reads lastPollingHealthTs which we initialize at start, plus we set heartbeatTimeoutMs huge → no stuck.
    const sig = collector.byType("watchdog_signal");
    expect(sig.length).toBe(1);
    expect((sig[0]!.payload as { kind: string }).kind).toBe("idle");
    expect((sig[0]!.payload as { severity: string }).severity).toBe("normal");
    // NO alert_emit should fire for idle (AC-14)
    const alerts = collector.byType("alert_emit");
    expect(alerts.length).toBe(0);
    expect(shutdownReason).toBe("watchdog:idle");
    wd.stop();
    collector.stop();
  });

  test("MODULE-001-T20 — alert_emit fires BEFORE watchdog_signal for failure severity (ordering invariant)", () => {
    // Already partially covered by T13 + T14 above; explicit re-statement here.
    const eb = new EventBus();
    const fc = fakeClock(0);
    const wd = new Watchdog({
      eventBus: eb,
      clock: fc,
      deploymentMode: "lazy-spawn",
      bootPpid: 100,
      getCurrentPpid: () => 100,
      requestShutdown: () => {},
    });
    const collector = new EventCollector(eb);
    wd.start();
    fc.tick(70_000); // stuck
    const alertIdx = collector.events.findIndex((e) => e.type === "alert_emit");
    const sigIdx = collector.events.findIndex((e) => e.type === "watchdog_signal");
    expect(alertIdx).toBeGreaterThanOrEqual(0);
    expect(sigIdx).toBeGreaterThanOrEqual(0);
    expect(alertIdx).toBeLessThan(sigIdx);
    wd.stop();
    collector.stop();
  });
});
