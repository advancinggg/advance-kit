import { describe, test, expect } from "bun:test";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { OutboundReplayQueue } from "../../src/telegram/outbound-replay-queue";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { realClock } from "../../src/daemon/clock";
import { EventBus } from "../../src/daemon/event-bus";

// MODULE-002-AC-28 external-behavior verification: sendMessage during quarantine.
// Together with outbound-replay-queue.test.ts (internal AC-28 cap/FIFO + AC-29/30),
// this covers the AC-28 "client envelope shape under quarantine" contract end-to-end.

function makeClient(opts: { queue?: OutboundReplayQueue } = {}) {
  const eventBus = new EventBus();
  const clock = realClock();
  const pollingStatus = new PollingStatusImpl(clock, eventBus);
  const client = new TelegramAPIClientImpl({
    token: "TEST_TOKEN",
    eventBus,
    clock,
    pollingStatus,
    apiBase: "https://localhost:65535", // unreachable; we won't actually POST
    outboundReplayQueue: opts.queue,
  });
  return { client, eventBus, clock, pollingStatus };
}

describe("MODULE-002-AC-28: client.sendMessage during quarantine", () => {
  test("no requester_session, no queue → returns stub queued envelope (preserves back-compat for M005 admin acks)", async () => {
    const { client, pollingStatus } = makeClient();
    pollingStatus.setState("quarantine");
    const env = await client.sendMessage({ chat_id: 999, text: "ack" });
    expect(env).toMatchObject({ delivered: false, queued: true });
    expect("eta_hint" in env && typeof env.eta_hint === "number").toBe(true);
  });

  test("requester_session + queue → enqueues into queue + returns queued envelope", async () => {
    const queue = new OutboundReplayQueue({ capacity: 50, clock: realClock() });
    const { client, pollingStatus } = makeClient({ queue });
    pollingStatus.setState("quarantine");
    const env = await client.sendMessage({ chat_id: 5, text: "from-tool" }, { requester_session: "sess-1" });
    expect(env).toMatchObject({ delivered: false, queued: true });
    expect(queue.size()).toBe(1);
  });

  test("queue at cap → returns capacity_exceeded envelope (NOT a thrown error)", async () => {
    const queue = new OutboundReplayQueue({ capacity: 2, clock: realClock() });
    const { client, pollingStatus } = makeClient({ queue });
    pollingStatus.setState("quarantine");
    // Fill cap via the public client surface.
    await client.sendMessage({ chat_id: 1, text: "a" }, { requester_session: "s1" });
    await client.sendMessage({ chat_id: 2, text: "b" }, { requester_session: "s2" });
    expect(queue.size()).toBe(2);
    // 3rd call hits cap → returns envelope, doesn't throw.
    const env = await client.sendMessage({ chat_id: 3, text: "c" }, { requester_session: "s3" });
    expect(env).toEqual({ delivered: false, error: "capacity_exceeded" });
    expect(queue.size()).toBe(2); // unchanged
  });

  test("requester_session set but no queue cfg → falls back to stub envelope (no throw)", async () => {
    const { client, pollingStatus } = makeClient(); // no queue
    pollingStatus.setState("quarantine");
    const env = await client.sendMessage({ chat_id: 9, text: "x" }, { requester_session: "sess" });
    expect(env).toMatchObject({ delivered: false, queued: true });
  });

  test("opts.requester_session is metadata only — NOT included in TG POST body (wire-schema clean)", async () => {
    // Spy on the POST: replace fetchFn with a recording stub that captures the body.
    let capturedBody: unknown = null;
    const queue = new OutboundReplayQueue({ capacity: 50, clock: realClock() });
    const fetchFn: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      // Mimic a successful TG response so sendMessage takes the "delivered" path.
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 42 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    const eventBus = new EventBus();
    const clock = realClock();
    const pollingStatus = new PollingStatusImpl(clock, eventBus);
    // state stays "running" so we take the POST path (NOT enqueue).
    const client = new TelegramAPIClientImpl({
      token: "TEST_TOKEN",
      eventBus,
      clock,
      pollingStatus,
      outboundReplayQueue: queue,
      fetchFn,
    });
    await client.sendMessage({ chat_id: 5, text: "x" }, { requester_session: "should-not-appear" });
    // The captured POST body should match the req only; no requester_session leaked.
    expect(capturedBody).toEqual({ chat_id: 5, text: "x" });
    expect(JSON.stringify(capturedBody)).not.toContain("requester_session");
  });
});
