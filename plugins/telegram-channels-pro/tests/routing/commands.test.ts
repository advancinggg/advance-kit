import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { SessionRegistry } from "../../src/routing/session-registry";
import { handleSessionCommand } from "../../src/routing/commands/session";
import { handleListCommand } from "../../src/routing/commands/list";
import { handleStatusCommand } from "../../src/routing/commands/status";
import { StatusReporter } from "../../src/obs/status-reporter";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface SentMsg {
  chat_id: number | string;
  text: string;
}
function makeMockTg(): { tg: { sendMessage: (req: { chat_id: number | string; text: string }) => Promise<{ delivered: true; message_id: number }> }; sent: SentMsg[] } {
  const sent: SentMsg[] = [];
  const tg = {
    sendMessage: async (req: { chat_id: number | string; text: string }) => {
      sent.push({ chat_id: req.chat_id, text: req.text });
      return { delivered: true as const, message_id: sent.length };
    },
  };
  return { tg, sent };
}

function makeRegistry(bus: EventBus, clock: ReturnType<typeof fakeClock>): SessionRegistry {
  const reg = new SessionRegistry({
    eventBus: bus,
    clock,
    capacity: 8,
    disconnectSession: () => undefined,
  });
  reg.installSubscribers();
  cleanups.push(() => reg.dispose());
  return reg;
}

describe("MODULE-005-AC-11: /session valid", () => {
  test("MODULE-005-T11 — /session a3f2e1c8 with matching session bumps to head; replies 'Switched focus to a3f2e1c8'", async () => {
    const bus = new EventBus();
    const clock = fakeClock(0);
    const reg = makeRegistry(bus, clock);
    const { tg, sent } = makeMockTg();
    bus.emit("session_connected", { session_id: "S1", shortid: "a3f2e1c8", branch: "main", ts: 0 });
    bus.emit("session_connected", { session_id: "S2", shortid: "deadbeef", branch: "main", ts: 1 });
    expect(reg.getFocus()?.shortid).toBe("deadbeef");
    await handleSessionCommand({
      shortid: "a3f2e1c8",
      chatId: 555,
      updateId: 100,
      tg: tg as never,
      eventBus: bus,
      registry: reg,
    });
    expect(reg.getFocus()?.shortid).toBe("a3f2e1c8");
    expect(sent).toEqual([{ chat_id: 555, text: "Switched focus to a3f2e1c8" }]);
  });
});

describe("MODULE-005-AC-12: /session invalid sanitization", () => {
  test("MODULE-005-T12 — /session ../etc/passwd → reply 'Invalid shortid format'; registry unchanged", async () => {
    const bus = new EventBus();
    const clock = fakeClock(0);
    const reg = makeRegistry(bus, clock);
    const { tg, sent } = makeMockTg();
    bus.emit("session_connected", { session_id: "S1", shortid: "abc123", branch: "main", ts: 0 });
    const sizeBefore = reg.size();
    await handleSessionCommand({
      shortid: "../etc/passwd",
      chatId: 555,
      updateId: 100,
      tg: tg as never,
      eventBus: bus,
      registry: reg,
    });
    expect(sent).toEqual([{ chat_id: 555, text: "Invalid shortid format" }]);
    expect(reg.size()).toBe(sizeBefore);
  });

  test("MODULE-005-T12b — /session abc;rm -rf and /session $HOME also rejected", async () => {
    const bus = new EventBus();
    const clock = fakeClock(0);
    const reg = makeRegistry(bus, clock);
    const { tg, sent } = makeMockTg();
    await handleSessionCommand({
      shortid: "abc;rm",
      chatId: 1,
      updateId: 1,
      tg: tg as never,
      eventBus: bus,
      registry: reg,
    });
    await handleSessionCommand({
      shortid: "$HOME",
      chatId: 1,
      updateId: 2,
      tg: tg as never,
      eventBus: bus,
      registry: reg,
    });
    expect(sent.length).toBe(2);
    for (const s of sent) {
      expect(s.text).toBe("Invalid shortid format");
    }
  });
});

describe("MODULE-005-AC-13: /list", () => {
  test("MODULE-005-T13 — /list with 2 entries returns formatted lines; empty list returns 'No sessions registered...'", async () => {
    const bus = new EventBus();
    const clock = fakeClock(0);
    const reg = makeRegistry(bus, clock);
    let { tg, sent } = makeMockTg();
    // empty case
    await handleListCommand({ chatId: 7, updateId: 1, tg: tg as never, eventBus: bus, registry: reg, clock });
    expect(sent[0]!.text).toContain("No sessions registered");
    // populated case
    bus.emit("session_connected", { session_id: "S1", shortid: "abc123", branch: "main", ts: 0 });
    bus.emit("session_connected", { session_id: "S2", shortid: "def456", branch: "feat", ts: 1 });
    sent = [];
    const tg2 = { sendMessage: async (req: { chat_id: number | string; text: string }) => { sent.push({ chat_id: req.chat_id, text: req.text }); return { delivered: true as const, message_id: 1 }; } };
    await handleListCommand({ chatId: 7, updateId: 2, tg: tg2 as never, eventBus: bus, registry: reg, clock });
    expect(sent[0]!.text).toContain("abc123");
    expect(sent[0]!.text).toContain("def456");
    expect(sent[0]!.text).toContain("main");
    expect(sent[0]!.text).toContain("feat");
  });
});

describe("MODULE-005-AC-14: /status", () => {
  test("MODULE-005-T14 — /status calls StatusReporter and replies with formatted summary", async () => {
    const bus = new EventBus();
    const clock = fakeClock(0);
    const sr = new StatusReporter(clock, "lazy-spawn", 0);
    sr.sessionConnected();
    sr.sessionConnected();
    sr.setPendingCapacity(3, 50);
    sr.setAdminSource("env");
    const { tg, sent } = makeMockTg();
    await handleStatusCommand({
      chatId: 555,
      updateId: 1,
      tg: tg as never,
      eventBus: bus,
      statusReporter: sr,
    });
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain("Daemon status");
    expect(sent[0]!.text).toContain("lazy-spawn");
    expect(sent[0]!.text).toContain("Registered sessions:    2");
    expect(sent[0]!.text).toContain("Pending approvals:      3 / 50");
    expect(sent[0]!.text).toContain("Admin source:           env");
  });
});
