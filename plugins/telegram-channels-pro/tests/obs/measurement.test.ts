import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { MeasurementHelper, type MeasurementSample } from "../../src/obs/measurement-helper";
import { EventCollector } from "../helpers/event-collector";

describe("MODULE-008-AC-15: stationary RSS/CPU sampling helper", () => {
  test("MODULE-008-T15 — sample only when 0 pending AND no tool_call in last 60s", () => {
    const eb = new EventBus();
    const clock = fakeClock(0);
    const samplesTaken: MeasurementSample[] = [];
    const helper = new MeasurementHelper({
      eventBus: eb,
      clock,
      daemonPid: 99,
      quietWindowMs: 60_000,
      // Large cadence so the auto setInterval never fires during this test;
      // we drive sampling via explicit helper.tick() calls.
      sampleCadenceMs: 999_999_999,
      sampleFn: (_pid) => {
        const s = { ts: clock.now(), rss_kb: 1024, cpu_pct: 0.5 };
        samplesTaken.push(s);
        return s;
      },
    });
    helper.start();
    // Phase 1: tool_call happens recently — manual tick; no sample expected (idleMs < 60s).
    eb.emit("tool_call", { session_id: "s1", request_id: "r1", tool: "reply" });
    helper.tick();
    expect(samplesTaken.length).toBe(0);
    // Phase 2: 31s passes with no tool_call; quiet window of 60s not yet reached.
    clock.tick(31_000);
    helper.tick();
    expect(samplesTaken.length).toBe(0);
    // Phase 3: 30 more seconds (total 61s of no tool_call) → sample taken.
    clock.tick(30_000);
    helper.tick();
    expect(samplesTaken.length).toBe(1);
    expect(samplesTaken[0]!.rss_kb).toBe(1024);
    helper.stop();
  });

  test("pending > 0 prevents sampling even if quiet window is satisfied", () => {
    const eb = new EventBus();
    const clock = fakeClock(0);
    const samplesTaken: MeasurementSample[] = [];
    const helper = new MeasurementHelper({
      eventBus: eb,
      clock,
      daemonPid: 99,
      quietWindowMs: 1000,
      sampleCadenceMs: 1000,
      sampleFn: () => {
        const s = { ts: clock.now(), rss_kb: 1, cpu_pct: 0 };
        samplesTaken.push(s);
        return s;
      },
    });
    helper.start();
    eb.emit("pending_capacity_snapshot", { current: 5, max: 50 });
    clock.tick(60_000);
    helper.tick();
    expect(samplesTaken.length).toBe(0);
    helper.stop();
  });

  test("emits log_emit event with kind=stationary_sample on sampling", () => {
    const eb = new EventBus();
    const clock = fakeClock(0);
    const helper = new MeasurementHelper({
      eventBus: eb,
      clock,
      daemonPid: 99,
      quietWindowMs: 1000,
      sampleCadenceMs: 1000,
      sampleFn: () => ({ ts: clock.now(), rss_kb: 1, cpu_pct: 0 }),
    });
    helper.start();
    const collector = new EventCollector(eb);
    clock.tick(2000);
    helper.tick();
    const logs = collector.byType("log_emit").filter((e) => (e.payload as { event_type: string }).event_type === "stationary_sample");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    helper.stop();
    collector.stop();
  });
});
