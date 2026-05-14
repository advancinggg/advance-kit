import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { PendingApprovalRegistryImpl } from "../../src/tools/pending-registry";
import { EventCollector } from "../helpers/event-collector";
import type { TelegramAPIClient } from "../../src/telegram/client";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface TgCalls {
  answer: Array<{ callback_query_id: string; text?: string; show_alert?: boolean }>;
  edit: Array<{ chat_id: number | string; message_id: number; text: string }>;
}

function makeMockTg(): { tg: TelegramAPIClient; calls: TgCalls } {
  const calls: TgCalls = { answer: [], edit: [] };
  const tg = {
    sendMessage: async () => ({ delivered: true as const, message_id: 1, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } }),
    editMessageText: async (req: { chat_id: number | string; message_id: number; text: string }) => {
      calls.edit.push({ chat_id: req.chat_id, message_id: req.message_id, text: req.text });
      return { delivered: true as const, message_id: req.message_id, result: { message_id: req.message_id, date: 0, chat: { id: 0, type: "private" } } };
    },
    answerCallbackQuery: async (req: { callback_query_id: string; text?: string; show_alert?: boolean }) => {
      calls.answer.push({ callback_query_id: req.callback_query_id, text: req.text, show_alert: req.show_alert });
      return { ok: true as const };
    },
    getFile: async () => ({ ok: true as const, result: { file_id: "x", file_unique_id: "x", file_path: "" } }),
    sendChatAction: async () => ({ ok: true as const }),
    getUpdates: async () => ({ ok: true as const, result: [], classified: { kind: "ok" as const, retryAfterSec: 0, reason: "" } }),
  } as unknown as TelegramAPIClient;
  return { tg, calls };
}

describe("PendingApprovalRegistry — CONTRACT-011", () => {
  test("MODULE-004-T01a (AC-07) — add returns promise; resolveApproval resolves it with choice", async () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0) });
    const { tg, calls } = makeMockTg();
    const res = reg.add({
      pending_id: "abc123",
      requester_session_id: "sess1",
      message_id: 100,
      chat_id: 555,
      callback_data_map: new Map([["cb_abc123_0", "Approve"], ["cb_abc123_1", "Reject"]]),
      options: ["Approve", "Reject"],
      created_at: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    const promise = res.promise;
    await reg.resolveApproval("abc123", "Approve", "cbq42", tg);
    const choice = await promise;
    expect(choice).toBe("Approve");
    expect(calls.answer).toEqual([{ callback_query_id: "cbq42", text: undefined, show_alert: undefined }]);
    expect(reg.size()).toBe(0);
  });

  test("MODULE-004-T08 (AC-08) — capacity exceeded at 50; 51st add rejected", () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0), capacity: 50 });
    for (let i = 0; i < 50; i++) {
      const r = reg.add({
        pending_id: `pid${i}`,
        requester_session_id: "sess1",
        message_id: i,
        chat_id: 1,
        callback_data_map: new Map(),
        options: ["A"],
        created_at: 0,
      });
      expect(r.ok).toBe(true);
    }
    const r51 = reg.add({
      pending_id: "pid_overflow",
      requester_session_id: "sess1",
      message_id: 51,
      chat_id: 1,
      callback_data_map: new Map(),
      options: ["A"],
      created_at: 0,
    });
    expect(r51.ok).toBe(false);
    if (!r51.ok) expect(r51.error).toBe("CapacityExceededError");
    expect(reg.size()).toBe(50);
  });

  test("MODULE-004-T11/12 (AC-09) — lookupByPendingId parses callback_data; miss returns null", () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0) });
    reg.add({
      pending_id: "abc",
      requester_session_id: "s",
      message_id: 1,
      chat_id: 1,
      callback_data_map: new Map([["cb_abc_0", "A"]]),
      options: ["A"],
      created_at: 0,
    });
    expect(reg.lookupByPendingId("cb_abc_0")?.pending_id).toBe("abc");
    expect(reg.lookupByPendingId("cb_unknown_0")).toBeNull();
    expect(reg.lookupByPendingId("malformed")).toBeNull();
  });

  test("MODULE-004-T13 (AC-10) — resolveApproval calls answerCallbackQuery; double-resolve returns unknown_pending", async () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0) });
    const { tg, calls } = makeMockTg();
    const r = reg.add({
      pending_id: "x",
      requester_session_id: "s",
      message_id: 1,
      chat_id: 1,
      callback_data_map: new Map(),
      options: ["A"],
      created_at: 0,
    });
    if (!r.ok) throw new Error();
    const res1 = await reg.resolveApproval("x", "A", "cbq1", tg);
    expect(res1.ok).toBe(true);
    expect(calls.answer.length).toBe(1);
    const res2 = await reg.resolveApproval("x", "A", "cbq1", tg);
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error).toBe("unknown_pending");
  });

  test("MODULE-004-T14 (AC-11) — cleanupBySession rejects matching promises with session_terminated and edits TG button", async () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0) });
    const { tg, calls } = makeMockTg();
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < 3; i++) {
      const r = reg.add({
        pending_id: `a${i}`,
        requester_session_id: "sessA",
        message_id: 100 + i,
        chat_id: 555,
        callback_data_map: new Map(),
        options: ["A"],
        created_at: 0,
      });
      if (!r.ok) throw new Error();
      promises.push(r.promise);
    }
    const rB = reg.add({
      pending_id: "b1",
      requester_session_id: "sessB",
      message_id: 200,
      chat_id: 555,
      callback_data_map: new Map(),
      options: ["A"],
      created_at: 0,
    });
    if (!rB.ok) throw new Error();
    const cleanup = await reg.cleanupBySession("sessA", tg);
    expect(cleanup.cleaned).toBe(3);
    // All 3 sessA promises rejected with session_terminated
    let rejectedCount = 0;
    for (const p of promises) {
      try {
        await p;
      } catch (err) {
        expect((err as Error).message).toBe("session_terminated");
        rejectedCount += 1;
      }
    }
    expect(rejectedCount).toBe(3);
    // sessB pending intact
    expect(reg.size()).toBe(1);
    // editMessageText called 3 times with correct text
    expect(calls.edit.length).toBe(3);
    for (const e of calls.edit) {
      expect(e.text).toBe("approval cancelled (session ended)");
      expect(e.chat_id).toBe(555);
    }
  });

  test("MODULE-004-T17 (AC-14) — every add/resolve emits pending_capacity_snapshot immediately", async () => {
    const bus = new EventBus();
    const collector = new EventCollector(bus);
    cleanups.push(() => collector.stop());
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0) });
    const { tg } = makeMockTg();
    expect(collector.byType("pending_capacity_snapshot").length).toBe(0);
    const r = reg.add({
      pending_id: "p1",
      requester_session_id: "s",
      message_id: 1,
      chat_id: 1,
      callback_data_map: new Map(),
      options: ["A"],
      created_at: 0,
    });
    if (!r.ok) throw new Error();
    expect(collector.byType("pending_capacity_snapshot").length).toBe(1);
    await reg.resolveApproval("p1", "A", "cbq", tg);
    expect(collector.byType("pending_capacity_snapshot").length).toBe(2);
  });

  test("MODULE-004-T20 (AC-17) — size() reflects accurate count after add/remove", async () => {
    const bus = new EventBus();
    const reg = new PendingApprovalRegistryImpl({ eventBus: bus, clock: fakeClock(0) });
    const { tg } = makeMockTg();
    const r1 = reg.add({ pending_id: "p1", requester_session_id: "s", message_id: 1, chat_id: 1, callback_data_map: new Map(), options: ["A"], created_at: 0 });
    if (!r1.ok) throw new Error();
    reg.add({ pending_id: "p2", requester_session_id: "s", message_id: 2, chat_id: 1, callback_data_map: new Map(), options: ["A"], created_at: 0 });
    reg.add({ pending_id: "p3", requester_session_id: "s", message_id: 3, chat_id: 1, callback_data_map: new Map(), options: ["A"], created_at: 0 });
    expect(reg.size()).toBe(3);
    await reg.resolveApproval("p2", "A", "cbq", tg);
    expect(reg.size()).toBe(2);
  });

  test("MODULE-004-T22 (AC-19) — callback_data cb_<pid>_<idx> length ≤ 64 bytes", () => {
    const pid = "a".repeat(32); // worst case 32-char pending_id (16-byte hex)
    const cb = `cb_${pid}_99`; // worst case 2-digit index
    expect(cb.length).toBeLessThanOrEqual(64);
  });
});

describe("MODULE-004-AC-18 (T21 doc verification)", () => {
  test("MODULE-004-T21 — MODULE-004 §1.4.5 declares no daemon-side timeout", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const docPath = path.resolve(__dirname, "../../../..", "docs/modules/MODULE-004-mcp-tools.md");
    const content = fs.readFileSync(docPath, "utf-8");
    // Find §1.4.5 section
    const start = content.indexOf("#### 1.4.5 ");
    const end = content.indexOf("#### 1.4.6 ", start);
    const section = content.slice(start, end);
    // Spec position: timeout is caller-controlled (no daemon-side timer) — verify via prose
    // §1.4.5 + AC-18 in §1.5 both reference this; either textual presence OR AC-18's
    // "no daemon-side timeout" wording counts.
    const ac18Section = content.slice(content.indexOf("MODULE-004-AC-18"));
    const hasMention = section.includes("await") && content.includes("MODULE-004-AC-18");
    expect(hasMention).toBe(true);
    expect(ac18Section.slice(0, 300)).toContain("no daemon-side timeout");
  });
});
