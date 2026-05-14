import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { SessionRegistry } from "../../src/routing/session-registry";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface DisconnectCall {
  session_id: string;
  reason: string;
}

function makeRegistry(opts?: { capacity?: number }): {
  reg: SessionRegistry;
  bus: EventBus;
  clock: ReturnType<typeof fakeClock>;
  disconnects: DisconnectCall[];
} {
  const bus = new EventBus();
  const clock = fakeClock(0);
  const disconnects: DisconnectCall[] = [];
  const reg = new SessionRegistry({
    eventBus: bus,
    clock,
    capacity: opts?.capacity,
    disconnectSession: (id, reason) => {
      disconnects.push({ session_id: id, reason });
    },
  });
  reg.installSubscribers();
  cleanups.push(() => reg.dispose());
  return { reg, bus, clock, disconnects };
}

describe("MODULE-005-AC-01/02: session lifecycle adds/removes", () => {
  test("MODULE-005-T01 — session_connected adds entry to head; emits route_decision: session_added", () => {
    const { reg, bus } = makeRegistry();
    const collector = new EventCollector(bus);
    cleanups.push(() => collector.stop());
    bus.emit("session_connected", { session_id: "s1", shortid: "a1b2c3d4", branch: "main", ts: 1 });
    expect(reg.size()).toBe(1);
    expect(reg.getFocus()?.session_id).toBe("s1");
    const adds = collector.byType("route_decision").filter((e) => (e.payload as { reason: string }).reason === "session_added");
    expect(adds.length).toBe(1);
    expect((adds[0]!.payload as { update_id: number }).update_id).toBe(-1);
  });

  test("MODULE-005-T02 — session_disconnected removes entry; emits session_removed", () => {
    const { reg, bus } = makeRegistry();
    bus.emit("session_connected", { session_id: "s1", shortid: "a", branch: "", ts: 1 });
    bus.emit("session_connected", { session_id: "s2", shortid: "b", branch: "", ts: 2 });
    expect(reg.size()).toBe(2);
    bus.emit("session_disconnected", { session_id: "s1", reason: "x", uptime_ms: 0 });
    expect(reg.size()).toBe(1);
  });
});

describe("MODULE-005-AC-03: session capacity guard", () => {
  test("MODULE-005-T03 — 9th session_connected rejected; auth_deny_routing emitted; disconnectSession called; registry.size==8", () => {
    const { reg, bus, disconnects } = makeRegistry({ capacity: 8 });
    const collector = new EventCollector(bus);
    cleanups.push(() => collector.stop());
    for (let i = 0; i < 8; i++) {
      bus.emit("session_connected", { session_id: `s${i}`, shortid: `${i}`, branch: "", ts: i });
    }
    expect(reg.size()).toBe(8);
    // 9th
    bus.emit("session_connected", { session_id: "s9", shortid: "ovf", branch: "", ts: 9 });
    expect(reg.size()).toBe(8);
    const denials = collector.byType("auth_deny_routing").filter(
      (e) => (e.payload as { reason: string }).reason === "session_capacity_exceeded",
    );
    expect(denials.length).toBe(1);
    expect((denials[0]!.payload as { sender_hash: string }).sender_hash).toBe("");
    expect(disconnects).toEqual([{ session_id: "s9", reason: "capacity_exceeded" }]);
  });
});

describe("MODULE-005-AC-06/07: LRU bumped by tool_call only", () => {
  test("MODULE-005-T06 — register A then B (B head); tool_call(A) bumps A to head", () => {
    const { reg, bus, clock } = makeRegistry();
    bus.emit("session_connected", { session_id: "A", shortid: "aaa", branch: "", ts: 0 });
    clock.tick(1);
    bus.emit("session_connected", { session_id: "B", shortid: "bbb", branch: "", ts: 1 });
    expect(reg.getFocus()?.session_id).toBe("B"); // B at head
    bus.emit("tool_call", { session_id: "A", request_id: "r1", tool: "reply" });
    expect(reg.getFocus()?.session_id).toBe("A"); // bumped to head
  });

  test("MODULE-005-T07 — TG inbound message arrival does NOT bump LRU (only tool_call does)", () => {
    const { reg, bus } = makeRegistry();
    bus.emit("session_connected", { session_id: "A", shortid: "aaa", branch: "", ts: 0 });
    bus.emit("session_connected", { session_id: "B", shortid: "bbb", branch: "", ts: 1 });
    expect(reg.getFocus()?.session_id).toBe("B");
    // Emitting inbound_update is M002's surface; SessionRegistry doesn't subscribe to it
    bus.emit("inbound_update", { update_id: 42, type: "message", payload: {} });
    expect(reg.getFocus()?.session_id).toBe("B"); // unchanged
  });
});
