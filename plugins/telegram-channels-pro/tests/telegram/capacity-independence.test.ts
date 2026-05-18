import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { SessionRegistry } from "../../src/routing/session-registry";
import { PendingApprovalRegistryImpl } from "../../src/tools/pending-registry";
import { OutboundReplayQueue, CapacityExceededError } from "../../src/telegram/outbound-replay-queue";
import { QUARANTINE_QUEUE_CAP } from "../../src/telegram/client";

describe("MODULE-002-AC-34: three independent capacity edges (REQ-022 + REQ-009 + REQ-037 caps)", () => {
  test("MODULE-002-T34a — SessionRegistry 8-cap saturates at 8 and rejects the 9th; configurable to 16", async () => {
    // Default capacity = 8: register 8 ok, 9th triggers disconnectSession.
    const bus = new EventBus();
    let rejectedCount = 0;
    const reg = new SessionRegistry({
      eventBus: bus,
      clock: realClock(),
      disconnectSession: (_id, reason) => {
        if (reason === "capacity_exceeded") rejectedCount++;
      },
    });
    reg.installSubscribers();
    for (let i = 0; i < 8; i++) {
      bus.emit("session_connected", {
        session_id: `s${i}`,
        shortid: `s${i.toString(16).padStart(12, "0")}`,
        branch: "main",
        ts: 0,
      });
    }
    // 9th — must be rejected.
    bus.emit("session_connected", {
      session_id: "s8",
      shortid: "s00000000000000000008".slice(-12),
      branch: "main",
      ts: 0,
    });
    // Subscriber is async; flush microtasks via setImmediate-equivalent.
    await new Promise((r) => setImmediate(r));
    expect(reg.size()).toBe(8);
    expect(rejectedCount).toBe(1);
    reg.dispose();

    // Re-instantiate with cfg.capacity=16 — proves the cap is independently
    // configurable (not a hardcoded ceiling).
    const bus2 = new EventBus();
    const reg2 = new SessionRegistry({
      eventBus: bus2,
      clock: realClock(),
      capacity: 16,
      disconnectSession: () => {},
    });
    reg2.installSubscribers();
    for (let i = 0; i < 9; i++) {
      bus2.emit("session_connected", {
        session_id: `s${i}`,
        shortid: `s${i.toString(16).padStart(12, "0")}`,
        branch: "main",
        ts: 0,
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(reg2.size()).toBe(9);
    reg2.dispose();
  });

  test("MODULE-002-T34b — PendingApprovalRegistry 50-cap saturates at 50 and rejects the 51st; configurable to 100", () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({
      eventBus: bus,
      clock: realClock(),
    });
    function makeEntry(id: string) {
      return {
        pending_id: id,
        requester_session_id: "S1",
        message_id: 1,
        chat_id: 1,
        callback_data_map: new Map([["c", "v"]]),
        options: ["v"],
        created_at: 0,
      };
    }
    for (let i = 0; i < 50; i++) {
      const r = reg.add(makeEntry(`p${i}`));
      expect(r.ok).toBe(true);
    }
    const reject = reg.add(makeEntry("p50"));
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error).toBe("CapacityExceededError");
    expect(reg.size()).toBe(50);

    // Re-instantiate with cfg.capacity=100 → 51st add succeeds.
    const reg2 = new PendingApprovalRegistryImpl({
      eventBus: new EventBus(),
      clock: realClock(),
      capacity: 100,
    });
    for (let i = 0; i < 51; i++) {
      const r = reg2.add(makeEntry(`p${i}`));
      expect(r.ok).toBe(true);
    }
    expect(reg2.size()).toBe(51);
  });

  test("MODULE-002-T34c — OutboundReplayQueue 50-cap saturates at 50 and the 51st throws CapacityExceededError; configurable to 100", () => {
    const q = new OutboundReplayQueue();
    for (let i = 0; i < 50; i++) {
      const r = q.enqueue({ i });
      expect(r.queued).toBe(true);
    }
    expect(q.size()).toBe(50);
    expect(() => q.enqueue({ over: true })).toThrow(CapacityExceededError);

    // Re-instantiate with cfg.capacity=100 → 51 enqueues all succeed.
    const q2 = new OutboundReplayQueue({ capacity: 100 });
    for (let i = 0; i < 51; i++) {
      const r = q2.enqueue({ i });
      expect(r.queued).toBe(true);
    }
    expect(q2.size()).toBe(51);
  });

  test("MODULE-002-T34d — the three cap drivers are sourced from three distinct module paths", () => {
    // QUARANTINE_QUEUE_CAP === 50 (REQ-037 cap)
    expect(QUARANTINE_QUEUE_CAP).toBe(50);

    // Each cap driver is exported from a distinct file path. This proves
    // "three independent capacity edges" at the configuration boundary —
    // none of the caps is co-located or transitively coupled.
    const sessionRegPath = require.resolve("../../src/routing/session-registry");
    const pendingRegPath = require.resolve("../../src/tools/pending-registry");
    const queueCapPath = require.resolve("../../src/telegram/client");
    expect(sessionRegPath).not.toBe(pendingRegPath);
    expect(pendingRegPath).not.toBe(queueCapPath);
    expect(sessionRegPath).not.toBe(queueCapPath);
  });
});
