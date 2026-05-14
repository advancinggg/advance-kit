import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { PendingApprovalRegistryImpl } from "../../src/tools/pending-registry";
import { SnapshotEmitter } from "../../src/tools/snapshot-emitter";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-004-AC-13: SnapshotEmitter periodic 30s emit", () => {
  test("MODULE-004-T16 — emits pending_capacity_snapshot every 30s tick", () => {
    const bus = new EventBus();
    const collector = new EventCollector(bus);
    cleanups.push(() => collector.stop());
    const clock = fakeClock(0);
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
    const emitter = new SnapshotEmitter({ registry: reg, eventBus: bus, clock, intervalMs: 30_000 });
    cleanups.push(() => emitter.stop());
    emitter.start();
    expect(collector.byType("pending_capacity_snapshot").length).toBe(0);
    clock.tick(30_000);
    expect(collector.byType("pending_capacity_snapshot").length).toBe(1);
    clock.tick(30_000);
    expect(collector.byType("pending_capacity_snapshot").length).toBe(2);
  });
});
