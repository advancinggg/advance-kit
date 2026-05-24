import { describe, test, expect, mock } from "bun:test";
import { WaitForResetHandshakeHandler } from "../../src/routing/wait-for-reset-handshake";
import { EventBus } from "../../src/daemon/event-bus";

// REQ-047 stream (c) — MODULE-005-AC-27 wait-for-reset handshake disconnect.
// Verifies that on session_connected, M005's handshake handler queries M006.isWaitForReset
// and calls M003.disconnectSession with the literal hint string when true.

const EXPECTED_REASON = "registration timed out; run reset-admin to retry";

interface MockAcceptor {
  disconnectSession: (sessionId: string, reason: string) => Promise<void> | void;
  calls: Array<{ session_id: string; reason: string }>;
}

function makeAcceptor(opts: { latencyMs?: number } = {}): MockAcceptor {
  const calls: Array<{ session_id: string; reason: string }> = [];
  return {
    calls,
    disconnectSession: (session_id: string, reason: string): Promise<void> | void => {
      calls.push({ session_id, reason });
      if (opts.latencyMs) {
        return new Promise<void>((res) => setTimeout(res, opts.latencyMs));
      }
      return undefined;
    },
  };
}

describe("MODULE-005-AC-27: WaitForResetHandshakeHandler", () => {
  test("MODULE-005-T27a — isWaitForReset()===true on session_connected → disconnectSession called with exact reason", () => {
    const bus = new EventBus();
    const acceptor = makeAcceptor();
    const handler = new WaitForResetHandshakeHandler({
      eventBus: bus,
      registrationGate: { isWaitForReset: () => true },
      acceptor,
    });
    handler.install();
    bus.emit("session_connected", { session_id: "sess-A", shortid: "abc", ts: 0 });
    expect(acceptor.calls.length).toBe(1);
    expect(acceptor.calls[0]).toEqual({ session_id: "sess-A", reason: EXPECTED_REASON });
    handler.dispose();
  });

  test("MODULE-005-T27b — isWaitForReset()===false → NO disconnect call", () => {
    const bus = new EventBus();
    const acceptor = makeAcceptor();
    const handler = new WaitForResetHandshakeHandler({
      eventBus: bus,
      registrationGate: { isWaitForReset: () => false },
      acceptor,
    });
    handler.install();
    bus.emit("session_connected", { session_id: "sess-A", shortid: "abc", ts: 0 });
    expect(acceptor.calls.length).toBe(0);
    handler.dispose();
  });

  test("MODULE-005-T27c-order — Handshake registered first; disconnect call recorded BEFORE another subscriber's session_added side-effect", () => {
    // Registration order matters per EventBus's insertion-order Set iteration.
    // We register the handshake FIRST, then a second subscriber that records its
    // invocation in a shared call-order log. Handshake's disconnect call should appear
    // first in the log.
    const bus = new EventBus();
    const acceptor = makeAcceptor();
    const callOrder: string[] = [];
    // Subscriber 1: handshake handler (registered first).
    const handshake = new WaitForResetHandshakeHandler({
      eventBus: bus,
      registrationGate: { isWaitForReset: () => true },
      acceptor: {
        disconnectSession: (session_id, reason) => {
          callOrder.push("handshake_disconnect");
          acceptor.calls.push({ session_id, reason });
        },
      },
    });
    handshake.install();
    // Subscriber 2: simulate SessionRegistry's session_added side-effect (registered second).
    bus.on("session_connected", () => {
      callOrder.push("session_registry_add");
    });
    bus.emit("session_connected", { session_id: "sess-A", shortid: "abc", ts: 0 });
    // Verify handshake disconnect was invoked BEFORE the registry-add subscriber.
    expect(callOrder).toEqual(["handshake_disconnect", "session_registry_add"]);
    handshake.dispose();
  });

  test("MODULE-005-T27d-idempotent — two session_connected for same session_id while disconnect in-flight → only ONE disconnect call", async () => {
    const bus = new EventBus();
    const acceptor = makeAcceptor({ latencyMs: 50 }); // disconnect is in-flight for 50ms
    const handler = new WaitForResetHandshakeHandler({
      eventBus: bus,
      registrationGate: { isWaitForReset: () => true },
      acceptor,
    });
    handler.install();
    // Fire two session_connected events with the same session_id back-to-back.
    bus.emit("session_connected", { session_id: "sess-A", shortid: "abc", ts: 0 });
    bus.emit("session_connected", { session_id: "sess-A", shortid: "abc", ts: 0 });
    // The Set guard suppresses the second call.
    expect(acceptor.calls.length).toBe(1);
    // Wait for the in-flight Promise to resolve + .finally() to clear the Set.
    await new Promise((res) => setTimeout(res, 100));
    // After the Set clears, a fresh event for the SAME session_id should fire again.
    bus.emit("session_connected", { session_id: "sess-A", shortid: "abc", ts: 0 });
    expect(acceptor.calls.length).toBe(2);
    handler.dispose();
  });

  test("MODULE-005-T27-integration — real RegistrationGate + handshake + mock acceptor end-to-end", async () => {
    // This integration test uses a stub RegistrationGate that returns true. The mock
    // acceptor verifies the full path: bus.emit → handshake handler subscribes → checks
    // gate → calls acceptor.disconnectSession with the literal reason.
    const bus = new EventBus();
    const acceptor = makeAcceptor();
    let gateState: "open" | "waiting_for_reset" = "open";
    const handler = new WaitForResetHandshakeHandler({
      eventBus: bus,
      registrationGate: { isWaitForReset: () => gateState === "waiting_for_reset" },
      acceptor,
    });
    handler.install();

    // Pre-condition: gate is open; session_connected should NOT trigger disconnect.
    bus.emit("session_connected", { session_id: "early", shortid: "a", ts: 0 });
    expect(acceptor.calls.length).toBe(0);

    // Transition to waiting_for_reset (simulating M006 global-trip).
    gateState = "waiting_for_reset";

    // Now a session_connected SHOULD trigger disconnect.
    bus.emit("session_connected", { session_id: "post-trip", shortid: "b", ts: 0 });
    expect(acceptor.calls.length).toBe(1);
    expect(acceptor.calls[0]).toEqual({ session_id: "post-trip", reason: EXPECTED_REASON });
    handler.dispose();
  });
});
