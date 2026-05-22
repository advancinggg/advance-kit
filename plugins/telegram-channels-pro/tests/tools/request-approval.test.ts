import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { PendingApprovalRegistryImpl } from "../../src/tools/pending-registry";
import { requestApproval } from "../../src/tools/request-approval";
import { AdminChatRegistry } from "../../src/routing/admin-chat-registry";
import { makeMockFetch } from "../helpers/http-mock";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-004-AC-07: request_approval round-trip", () => {
  test("MODULE-004-T09 — claude calls request_approval → mock TG returns message_id → simulated callback resolves promise with choice", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const registry = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
    const adminChatReg = new AdminChatRegistry(undefined);
    adminChatReg.setFromEnvForTest(555);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: { message_id: 42, date: 0, chat: { id: 555, type: "private" } } },
    });
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const ctx = {
      tg,
      registry,
      adminChatRegistry: adminChatReg,
      clock,
      requesterSessionId: "sess1",
      chatTypeCache: { getChatType: async () => "private" as const, primeCache: () => {} },
      eventBus: bus,
    };
    // Fire request_approval (async — the Promise resolves only when M005-side simulation calls resolveApproval)
    const promise = requestApproval({ text: "Confirm?", options: ["Yes", "No"] }, ctx);
    // Wait one tick for the sendMessage to complete
    await new Promise((r) => setTimeout(r, 10));
    // Verify entry in registry
    expect(registry.size()).toBe(1);
    // Find the pending_id from the entries
    const entryByCb = registry.lookupByPendingId("cb_" + (registry as unknown as { entries: Map<string, { pending_id: string }> }).entries.keys().next().value + "_0");
    expect(entryByCb).not.toBeNull();
    const pid = entryByCb!.pending_id;
    // Simulate M005's callback resolution path
    mock.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true } }); // answerCallbackQuery
    await registry.resolveApproval(pid, "Yes", "cbq42", tg);
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok:true, got ${JSON.stringify(result)}`);
    expect(result.result.choice).toBe("Yes");
    expect(result.result.pending_id).toBe(pid);
  });

  test("MODULE-004-T09b — NoAdminChatConfigured when registry empty + env unset", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const registry = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
    const adminChatReg = new AdminChatRegistry(undefined);
    const mock = makeMockFetch();
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const r = await requestApproval(
      { text: "Confirm?", options: ["Yes", "No"] },
      {
        tg,
        registry,
        adminChatRegistry: adminChatReg,
        clock,
        requesterSessionId: "sess1",
        chatTypeCache: { getChatType: async () => "private" as const, primeCache: () => {} },
        eventBus: bus,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("NoAdminChatConfigured");
      expect(r.hint).toBeDefined();
    }
  });

  test("MODULE-004-T09c — InvalidOptionsLength rejects empty + >10 options", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const registry = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
    const adminChatReg = new AdminChatRegistry(undefined);
    adminChatReg.setFromEnvForTest(555);
    const mock = makeMockFetch();
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const ctx = {
      tg,
      registry,
      adminChatRegistry: adminChatReg,
      clock,
      requesterSessionId: "s",
      chatTypeCache: { getChatType: async () => "private" as const, primeCache: () => {} },
      eventBus: bus,
    };
    const r1 = await requestApproval({ text: "x", options: [] }, ctx);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("InvalidOptionsLength");
    const r2 = await requestApproval({ text: "x", options: Array(11).fill("a") }, ctx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("InvalidOptionsLength");
  });
});
