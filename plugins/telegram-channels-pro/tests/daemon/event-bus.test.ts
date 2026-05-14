import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";

describe("MODULE-001-AC-09/AC-10: EventBus pub/sub primitives", () => {
  test("MODULE-001-T11 — emit reaches a synchronous subscriber within the same call", () => {
    const eb = new EventBus();
    let received: number | null = null;
    eb.on("daemon_start", (p) => {
      received = p.pid;
    });
    eb.emit("daemon_start", { pid: 42, boot_ts: 1, bun_version: "1.0", deployment_mode: "lazy-spawn" });
    expect(received).toBe(42);
  });

  test("MODULE-001-T11b — multiple subscribers all receive the event", () => {
    const eb = new EventBus();
    const seen: number[] = [];
    eb.on("daemon_start", (p) => seen.push(p.pid));
    eb.on("daemon_start", (p) => seen.push(p.pid + 1000));
    eb.emit("daemon_start", { pid: 7, boot_ts: 0, bun_version: "x", deployment_mode: "lazy-spawn" });
    expect(seen.sort((a, b) => a - b)).toEqual([7, 1007]);
  });

  test("MODULE-001-T11c — array form on(['a', 'b'], handler) subscribes to both", () => {
    const eb = new EventBus();
    let count = 0;
    eb.on(["polling_health", "polling_event"], () => count++);
    eb.emit("polling_health", { ts: 0, state: "running" });
    eb.emit("polling_event", { kind: "conflict_409" });
    expect(count).toBe(2);
  });

  test("MODULE-001-T12 — bounded queue overflow drops oldest + emits subscriber_queue_drop", async () => {
    const eb = new EventBus();
    const received: number[] = [];
    eb.on(
      "daemon_start",
      async (p) => {
        await new Promise<void>((res) => setTimeout(res, 5));
        received.push(p.pid);
      },
      { queueSize: 2, subscriberId: "drop-test" },
    );
    let dropEvent: { subscriber_id: string; drop_count: number; event_type: string } | null = null;
    eb.on("subscriber_queue_drop", (p) => {
      dropEvent = p;
    });
    // Emit 5 events into a queue of size 2.
    for (let i = 0; i < 5; i++) {
      eb.emit("daemon_start", { pid: i, boot_ts: 0, bun_version: "x", deployment_mode: "lazy-spawn" });
    }
    // wait for drain
    await new Promise<void>((res) => setTimeout(res, 100));
    expect(dropEvent).not.toBeNull();
    expect(dropEvent!.subscriber_id).toBe("drop-test");
    expect(dropEvent!.event_type).toBe("daemon_start");
    expect(dropEvent!.drop_count).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeGreaterThanOrEqual(2); // at least the final 2 got delivered
  });

  test("subscribe + unsubscribe removes the handler", () => {
    const eb = new EventBus();
    let count = 0;
    const unsub = eb.on("daemon_start", () => count++);
    eb.emit("daemon_start", { pid: 1, boot_ts: 0, bun_version: "x", deployment_mode: "lazy-spawn" });
    unsub();
    eb.emit("daemon_start", { pid: 1, boot_ts: 0, bun_version: "x", deployment_mode: "lazy-spawn" });
    expect(count).toBe(1);
  });
});
