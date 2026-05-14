import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock, realClock } from "../../src/daemon/clock";
import { AdminAllowlistImpl } from "../../src/auth/allowlist";
import { RegistrationGateImpl } from "../../src/auth/registration-gate";
import { StatusReporter } from "../../src/obs/status-reporter";
import { PendingApprovalRegistryImpl } from "../../src/tools/pending-registry";
import { SessionRegistry } from "../../src/routing/session-registry";
import { AdminChatRegistry } from "../../src/routing/admin-chat-registry";
import { NoSessionReplyThrottle } from "../../src/routing/no-session-throttle";
import { InboundDispatcher } from "../../src/routing/inbound-dispatcher";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";
import type { TelegramAPIClient } from "../../src/telegram/client";
import type { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface TgCalls {
  send: Array<{ chat_id: number | string; text: string; reply_markup?: unknown }>;
  edit: Array<{ chat_id: number | string; message_id: number; text: string }>;
  answer: Array<{ callback_query_id: string; text?: string; show_alert?: boolean }>;
}
function makeMockTg(): { tg: TelegramAPIClient; calls: TgCalls } {
  const calls: TgCalls = { send: [], edit: [], answer: [] };
  const tg = {
    sendMessage: async (req: { chat_id: number | string; text: string; reply_markup?: unknown }) => {
      calls.send.push(req);
      return { delivered: true as const, message_id: calls.send.length, result: { message_id: calls.send.length, date: 0, chat: { id: 0, type: "private" } } };
    },
    editMessageText: async (req: { chat_id: number | string; message_id: number; text: string }) => {
      calls.edit.push(req);
      return { delivered: true as const, message_id: req.message_id, result: { message_id: req.message_id, date: 0, chat: { id: 0, type: "private" } } };
    },
    answerCallbackQuery: async (req: { callback_query_id: string; text?: string; show_alert?: boolean }) => {
      calls.answer.push(req);
      return { ok: true as const };
    },
    getFile: async () => ({ ok: true as const, result: { file_id: "x", file_unique_id: "x", file_path: "" } }),
    sendChatAction: async () => ({ ok: true as const }),
    getUpdates: async () => ({ ok: true as const, result: [], classified: { kind: "ok" as const, retryAfterSec: 0, reason: "" } }),
  } as unknown as TelegramAPIClient;
  return { tg, calls };
}

interface AcceptorStub {
  delivered: Array<{ session_id: string; payload: unknown }>;
  setNextDeliverResult(r: { ok: true } | { ok: false; error: "unknown_session" | "write_failed" }): void;
}
function makeMockAcceptor(): { acceptor: MCPDaemonAcceptor; stub: AcceptorStub } {
  const delivered: AcceptorStub["delivered"] = [];
  let nextResult: { ok: true } | { ok: false; error: "unknown_session" | "write_failed" } = { ok: true };
  const queue: Array<typeof nextResult> = [];
  const acceptor = {
    deliverToSession: async (id: string, payload: unknown) => {
      delivered.push({ session_id: id, payload });
      if (queue.length > 0) return queue.shift()!;
      return nextResult;
    },
    disconnectSession: async () => undefined,
    registerToolHandler: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  } as unknown as MCPDaemonAcceptor;
  const stub: AcceptorStub = {
    delivered,
    setNextDeliverResult(r) {
      queue.push(r);
      nextResult = { ok: true };
    },
  };
  return { acceptor, stub };
}

interface Harness {
  bus: EventBus;
  clock: ReturnType<typeof fakeClock>;
  reg: SessionRegistry;
  pendingReg: PendingApprovalRegistryImpl;
  adminChatReg: AdminChatRegistry;
  allowlist: AdminAllowlistImpl;
  gate: RegistrationGateImpl;
  sr: StatusReporter;
  throttle: NoSessionReplyThrottle;
  dispatcher: InboundDispatcher;
  tgCalls: TgCalls;
  acceptorStub: AcceptorStub;
  cleanup: () => void;
}

async function makeHarness(opts?: { adminUserIds?: number[] }): Promise<Harness> {
  const tmp = makeTmpStateDir();
  await tmp.stateDir.initialize();
  cleanups.push(tmp.cleanup);
  const bus = tmp.eventBus;
  const clock = fakeClock(0);
  const allowlist = new AdminAllowlistImpl();
  if (opts?.adminUserIds && opts.adminUserIds.length > 0) {
    allowlist.setFromEnv(opts.adminUserIds);
  }
  const gate = new RegistrationGateImpl({
    stateDir: tmp.stateDir,
    allowlist,
    clock,
    eventBus: bus,
    deploymentMode: "lazy-spawn",
    emitCodeToStderr: () => undefined,
  });
  const sr = new StatusReporter(clock, "lazy-spawn", 0);
  const pendingReg = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
  const adminChatReg = new AdminChatRegistry(undefined);
  const { acceptor, stub } = makeMockAcceptor();
  const reg = new SessionRegistry({
    eventBus: bus,
    clock,
    capacity: 8,
    disconnectSession: (id, reason) => acceptor.disconnectSession(id, reason),
  });
  reg.installSubscribers();
  const throttle = new NoSessionReplyThrottle(clock, 5 * 60_000);
  const { tg, calls: tgCalls } = makeMockTg();
  const dispatcher = new InboundDispatcher({
    tg,
    eventBus: bus,
    clock,
    acceptor,
    adminAllowlist: allowlist,
    registrationGate: gate,
    statusReporter: sr,
    pendingRegistry: pendingReg,
    sessionRegistry: reg,
    adminChatRegistry: adminChatReg,
    throttle,
  });
  dispatcher.install();
  return {
    bus, clock, reg, pendingReg, adminChatReg, allowlist, gate, sr, throttle,
    dispatcher, tgCalls, acceptorStub: stub,
    cleanup: () => {
      dispatcher.dispose();
      reg.dispose();
    },
  };
}

describe("MODULE-005-AC-04/05: inbound text dispatch + admin gate", () => {
  test("MODULE-005-T04 — admin sends inbound text → registry has session A → deliverToSession(A, ...) called", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    h.bus.emit("session_connected", { session_id: "A", shortid: "abc", branch: "main", ts: 0 });
    h.bus.emit("inbound_update", {
      update_id: 42,
      type: "message",
      payload: {
        message_id: 1,
        from: { id: 99 },
        chat: { id: 555, type: "private" },
        text: "hello",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.acceptorStub.delivered.length).toBe(1);
    expect(h.acceptorStub.delivered[0]!.session_id).toBe("A");
  });

  test("MODULE-005-T05 — non-admin inbound text → auth_deny_routing emitted; no deliverToSession", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    const collector = new EventCollector(h.bus);
    cleanups.push(() => collector.stop());
    h.bus.emit("session_connected", { session_id: "A", shortid: "abc", branch: "main", ts: 0 });
    h.bus.emit("inbound_update", {
      update_id: 1,
      type: "message",
      payload: { message_id: 1, from: { id: 7 }, chat: { id: 555, type: "private" }, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.acceptorStub.delivered.length).toBe(0);
    const denials = collector.byType("auth_deny_routing").filter((e) => (e.payload as { reason: string }).reason === "inbound_text_deny");
    expect(denials.length).toBe(1);
  });
});

describe("MODULE-005-AC-15/16: no-session throttle + /list independence", () => {
  test("MODULE-005-T15 — 5 inbound texts to admin chat in 5min, 0 sessions → only 1 no-session reply sent", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    for (let i = 0; i < 5; i++) {
      h.bus.emit("inbound_update", {
        update_id: i,
        type: "message",
        payload: { message_id: i, from: { id: 99 }, chat: { id: 555, type: "private" }, text: `hi-${i}` },
      });
    }
    await new Promise((r) => setTimeout(r, 30));
    const noSessionReplies = h.tgCalls.send.filter((s) => s.text.includes("No active claude session"));
    expect(noSessionReplies.length).toBe(1);
  });

  test("MODULE-005-T16 — /list independent from no-session throttle", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    // Trigger throttle first
    h.bus.emit("inbound_update", {
      update_id: 1,
      type: "message",
      payload: { message_id: 1, from: { id: 99 }, chat: { id: 555, type: "private" }, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.tgCalls.send.length).toBe(1); // no-session reply consumed
    // Now /list — should still fire
    h.bus.emit("inbound_update", {
      update_id: 2,
      type: "message",
      payload: { message_id: 2, from: { id: 99 }, chat: { id: 555, type: "private" }, text: "/list" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.tgCalls.send.length).toBe(2);
    expect(h.tgCalls.send[1]!.text).toContain("No sessions registered");
  });
});

describe("MODULE-005-AC-08/09/10: callback dispatch", () => {
  test("MODULE-005-T08 — admin callback resolves pending; promise resolves with choice", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    const r = h.pendingReg.add({
      pending_id: "abc123",
      requester_session_id: "S",
      message_id: 100,
      chat_id: 555,
      callback_data_map: new Map([["cb_abc123_0", "Yes"]]),
      options: ["Yes"],
      created_at: 0,
    });
    if (!r.ok) throw new Error();
    h.bus.emit("inbound_update", {
      update_id: 1,
      type: "callback_query",
      payload: {
        id: "cbq42",
        from: { id: 99 },
        data: "cb_abc123_0",
      },
    });
    const choice = await r.promise;
    expect(choice).toBe("Yes");
    // tg.answerCallbackQuery should have been called with cbq42
    expect(h.tgCalls.answer.length).toBe(1);
    expect(h.tgCalls.answer[0]!.callback_query_id).toBe("cbq42");
  });

  test("MODULE-005-T09 — non-admin callback → silent drop (NO answerCallbackQuery), auth_deny_routing emitted", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    const collector = new EventCollector(h.bus);
    cleanups.push(() => collector.stop());
    h.bus.emit("inbound_update", {
      update_id: 1,
      type: "callback_query",
      payload: { id: "cbq", from: { id: 7 }, data: "cb_abc_0" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.tgCalls.answer.length).toBe(0); // SILENT drop
    const denials = collector.byType("auth_deny_routing").filter((e) => (e.payload as { reason: string }).reason === "callback_deny");
    expect(denials.length).toBe(1);
  });

  test("MODULE-005-T10/AC-10+12 — empty pendingRegistry; admin clicks → answerCallbackQuery with 'approval expired' + show_alert", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    h.bus.emit("inbound_update", {
      update_id: 1,
      type: "callback_query",
      payload: { id: "cbq", from: { id: 99 }, data: "cb_unknown_0" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.tgCalls.answer.length).toBe(1);
    expect(h.tgCalls.answer[0]!.callback_query_id).toBe("cbq");
    expect(h.tgCalls.answer[0]!.text).toBe("approval expired");
    expect(h.tgCalls.answer[0]!.show_alert).toBe(true);
  });
});

describe("MODULE-005-AC-18: cleanup on session_disconnected", () => {
  test("MODULE-005-T18 — session_disconnected triggers pendingRegistry.cleanupBySession", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    const r = h.pendingReg.add({
      pending_id: "p",
      requester_session_id: "A",
      message_id: 100,
      chat_id: 555,
      callback_data_map: new Map(),
      options: ["x"],
      created_at: 0,
    });
    if (!r.ok) throw new Error();
    h.bus.emit("session_disconnected", { session_id: "A", reason: "x", uptime_ms: 0 });
    let rejected = false;
    try {
      await r.promise;
    } catch (err) {
      expect((err as Error).message).toBe("session_terminated");
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("MODULE-005-AC-20: stale-deliver fallback", () => {
  test("MODULE-005-T20 — focus session A returns unknown_session → registry removes A → fall through to next focus B", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    h.bus.emit("session_connected", { session_id: "B", shortid: "bbb", branch: "", ts: 0 });
    h.bus.emit("session_connected", { session_id: "A", shortid: "aaa", branch: "", ts: 1 });
    expect(h.reg.getFocus()?.session_id).toBe("A"); // newest at head
    // First deliver call returns unknown_session
    h.acceptorStub.setNextDeliverResult({ ok: false, error: "unknown_session" });
    h.bus.emit("inbound_update", {
      update_id: 5,
      type: "message",
      payload: { message_id: 1, from: { id: 99 }, chat: { id: 555, type: "private" }, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.acceptorStub.delivered.length).toBe(2);
    expect(h.acceptorStub.delivered[0]!.session_id).toBe("A");
    expect(h.acceptorStub.delivered[1]!.session_id).toBe("B"); // fallback
    expect(h.reg.size()).toBe(1); // A removed
  });
});

describe("MODULE-005-AC-17: registration window forwarding", () => {
  test("MODULE-005-T17 — RegistrationGate.isInRegistrationWindow=true; admin DMs 'register CODE' → processRegistrationDM consumed; no further routing", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    h.gate.openWindow();
    const code = h.gate.currentCodeForTest()!;
    h.bus.emit("inbound_update", {
      update_id: 1,
      type: "message",
      payload: { message_id: 1, from: { id: 99 }, chat: { id: 555, type: "private" }, text: `register ${code}` },
    });
    await new Promise((r) => setTimeout(r, 10));
    // Successful registration — gate transitions to closed
    expect(h.gate.state()).toBe("closed");
    // No deliverToSession or no-session reply — registration consumed the message
    expect(h.acceptorStub.delivered.length).toBe(0);
    expect(h.tgCalls.send.length).toBe(0);
  });
});

describe("MODULE-005-AC-19: dispatch latency micro-benchmark (AC-19)", () => {
  test("MODULE-005-T19 — 5000 inbound texts (after 200 warm-up) max-per-call < 5ms in-process", async () => {
    const h = await makeHarness({ adminUserIds: [99] });
    cleanups.push(h.cleanup);
    h.bus.emit("session_connected", { session_id: "A", shortid: "x", branch: "", ts: 0 });
    // warm-up
    for (let i = 0; i < 200; i++) {
      h.bus.emit("inbound_update", {
        update_id: i,
        type: "message",
        payload: { message_id: i, from: { id: 99 }, chat: { id: 555, type: "private" }, text: `m${i}` },
      });
    }
    await new Promise((r) => setTimeout(r, 50));
    let maxMs = 0;
    for (let i = 0; i < 5000; i++) {
      const t = performance.now();
      h.bus.emit("inbound_update", {
        update_id: 1000 + i,
        type: "message",
        payload: { message_id: i, from: { id: 99 }, chat: { id: 555, type: "private" }, text: `m${i}` },
      });
      const elapsed = performance.now() - t;
      if (elapsed > maxMs) maxMs = elapsed;
    }
    // bus.emit is synchronous; the deliverToSession Promise is not awaited here.
    // We're measuring the in-process synchronous decision path (subscriber dispatch + admin
    // gate + LRU lookup).
    expect(maxMs).toBeLessThan(5);
  });
});
