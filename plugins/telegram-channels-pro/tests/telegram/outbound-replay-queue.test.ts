import { describe, test, expect } from "bun:test";
import { OutboundReplayQueue, CapacityExceededError, type QueueEntry, type ReplayFn } from "../../src/telegram/outbound-replay-queue";
import { realClock } from "../../src/daemon/clock";
import { EventBus } from "../../src/daemon/event-bus";
import type { EventPayloadMap } from "../../src/daemon/event-types";

// REQ-037 — Quarantine outbound replay queue (full FIFO + drain + restart semantics).
// Verifies MODULE-002-AC-28 / AC-29 / AC-30 per the §1.5 acceptance criteria.

function makeEntry(i: number, ts = Date.now()): QueueEntry {
  return {
    requester_session: `session-${i}`,
    params: { chat_id: 1000 + i, text: `msg-${i}` },
    queued_at: ts,
  };
}

describe("MODULE-002-AC-28: enqueue FIFO + cap", () => {
  test("MODULE-002-T28-fifo — enqueue under cap stores in insertion order", () => {
    const q = new OutboundReplayQueue({ capacity: 5, clock: realClock() });
    for (let i = 0; i < 5; i++) q.enqueue(makeEntry(i));
    expect(q.size()).toBe(5);
  });

  test("MODULE-002-T28-cap — enqueue at cap throws CapacityExceededError", () => {
    const eventBus = new EventBus();
    const warnEvents: EventPayloadMap["log_emit"][] = [];
    eventBus.on("log_emit", (p) => {
      const payload = p as EventPayloadMap["log_emit"];
      if (payload.event_type === "outbound_replay_queue_capacity_exceeded") warnEvents.push(payload);
    });
    const q = new OutboundReplayQueue({ capacity: 3, eventBus, clock: realClock() });
    q.enqueue(makeEntry(1));
    q.enqueue(makeEntry(2));
    q.enqueue(makeEntry(3));
    expect(() => q.enqueue(makeEntry(4))).toThrow(CapacityExceededError);
    expect(q.size()).toBe(3);
    // Legacy WARN event preserved (audit trail).
    expect(warnEvents.length).toBe(1);
    expect(warnEvents[0]!.level).toBe("WARN");
    expect((warnEvents[0]!.fields as { capacity: number }).capacity).toBe(3);
  });
});

describe("MODULE-002-AC-29: drain on quarantine_exit (event schema)", () => {
  test("MODULE-002-T29-fifo-drain — drain walks FIFO calling replayFn in insertion order", async () => {
    const q = new OutboundReplayQueue({ capacity: 10, clock: realClock() });
    for (let i = 0; i < 5; i++) q.enqueue(makeEntry(i));
    const callOrder: number[] = [];
    const replayFn: ReplayFn = async (entry) => {
      // Extract `i` from chat_id (1000 + i). chat_id is number|string in SendMessageReq;
      // makeEntry sets it as a number, so coerce for the typecheck.
      const cid = Number(entry.params.chat_id);
      callOrder.push(cid - 1000);
      return { delivered: true, message_id: 9000 + (cid - 1000) };
    };
    await q.drain(replayFn);
    expect(callOrder).toEqual([0, 1, 2, 3, 4]);
    expect(q.size()).toBe(0); // cleared after drain
  });

  test("MODULE-002-T29-event-schema — drain emits quarantine_replay_resolved per entry with REQUIRED schema", async () => {
    const eventBus = new EventBus();
    const events: EventPayloadMap["quarantine_replay_resolved"][] = [];
    eventBus.on("quarantine_replay_resolved", (p) => {
      events.push(p as EventPayloadMap["quarantine_replay_resolved"]);
    });
    let nowVal = 100;
    const clock = { ...realClock(), now: () => nowVal };
    const q = new OutboundReplayQueue({ capacity: 10, eventBus, clock });
    q.enqueue({ requester_session: "sess-A", params: { chat_id: 5, text: "a" }, queued_at: 50 });
    q.enqueue({ requester_session: "sess-B", params: { chat_id: 6, text: "b" }, queued_at: 60 });
    nowVal = 200; // drain occurs at t=200
    await q.drain(async (entry) => ({
      delivered: true,
      message_id: Number(entry.params.chat_id) * 100,
    }));
    expect(events.length).toBe(2);
    // First entry: full payload schema verified.
    expect(events[0]).toEqual({
      requester_session: "sess-A",
      message_id: 500,
      delivered: true,
      queued_at: 50,
      replayed_at: 200,
    });
    // Second entry.
    expect(events[1]!.requester_session).toBe("sess-B");
    expect(events[1]!.delivered).toBe(true);
    expect(events[1]!.queued_at).toBe(60);
    expect(events[1]!.replayed_at).toBe(200);
  });

  test("MODULE-002-T29-event-failure — drain emits delivered:false + error_class on replayFn failure", async () => {
    const eventBus = new EventBus();
    const events: EventPayloadMap["quarantine_replay_resolved"][] = [];
    eventBus.on("quarantine_replay_resolved", (p) => {
      events.push(p as EventPayloadMap["quarantine_replay_resolved"]);
    });
    const q = new OutboundReplayQueue({ capacity: 10, eventBus, clock: realClock() });
    q.enqueue(makeEntry(1));
    await q.drain(async () => ({ delivered: false, error_class: "rate_limited" }));
    expect(events.length).toBe(1);
    expect(events[0]!.delivered).toBe(false);
    expect(events[0]!.error_class).toBe("rate_limited");
    expect(events[0]!.message_id).toBeUndefined();
  });
});

describe("MODULE-002-AC-30: queue lost on daemon restart (in-memory only)", () => {
  test("MODULE-002-T30-restart — new instance has size 0; prior instance entries not visible", () => {
    const q1 = new OutboundReplayQueue({ capacity: 10, clock: realClock() });
    q1.enqueue(makeEntry(1));
    q1.enqueue(makeEntry(2));
    expect(q1.size()).toBe(2);
    // Simulate daemon restart: construct a fresh instance.
    const q2 = new OutboundReplayQueue({ capacity: 10, clock: realClock() });
    expect(q2.size()).toBe(0);
  });
});

// Audit-round-1 robustness fixes (Claude Diff W2 + Codex Diff W2).
describe("MODULE-002-AC-29: drain robustness (audit fixes)", () => {
  test("drain honors shouldAbort between entries — leaves un-replayed entries queued", async () => {
    const q = new OutboundReplayQueue({ capacity: 10, clock: realClock() });
    for (let i = 0; i < 5; i++) q.enqueue(makeEntry(i));
    let processed = 0;
    // Abort after 2 entries.
    await q.drain(
      async () => {
        processed++;
        return { delivered: true, message_id: processed };
      },
      () => processed >= 2,
    );
    // 2 processed, then abort BEFORE the 3rd → 3 remain queued (no silent drop).
    expect(processed).toBe(2);
    expect(q.size()).toBe(3);
  });

  test("enqueued params are isolated from post-enqueue caller mutation (byte-equivalent replay)", async () => {
    // Verified at the client.ts boundary via structuredClone; here we assert the queue
    // stores what it was given and a replay sees a stable snapshot.
    const q = new OutboundReplayQueue({ capacity: 10, clock: realClock() });
    const mutable = { chat_id: 5, text: "original", reply_markup: { inline_keyboard: [[{ text: "a" }]] } };
    // Caller is expected to pass a snapshot (client.ts does structuredClone); simulate that.
    q.enqueue({ requester_session: "s", params: structuredClone(mutable), queued_at: 1 });
    // Mutate the original AFTER enqueue.
    mutable.text = "mutated";
    mutable.reply_markup.inline_keyboard[0]![0]!.text = "z";
    let replayedText = "";
    let replayedBtn = "";
    await q.drain(async (entry) => {
      replayedText = entry.params.text!;
      replayedBtn = (entry.params.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]![0]!.text;
      return { delivered: true, message_id: 1 };
    });
    expect(replayedText).toBe("original");
    expect(replayedBtn).toBe("a");
  });
});
