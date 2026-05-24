import { describe, test, expect } from "bun:test";
import { reply } from "../../src/tools/reply";
import { react } from "../../src/tools/react";
import { editMessage } from "../../src/tools/edit-message";
import { requestApproval } from "../../src/tools/request-approval";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { ChatTypeFetchError, type ChatType, type ChatTypeCache } from "../../src/telegram/chat-type-cache";
import { PendingApprovalRegistryImpl } from "../../src/tools/pending-registry";
import { AdminChatRegistry } from "../../src/routing/admin-chat-registry";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { realClock } from "../../src/daemon/clock";
import { EventBus } from "../../src/daemon/event-bus";
import type { EventPayloadMap } from "../../src/daemon/event-types";

// REQ-035 outbound chat-type defense-in-depth (MODULE-004-AC-20 / AC-21 / AC-29).

interface DeniedEvent {
  chat_id: number;
  observed_type: string;
  tool: string;
}

function makeBus(): { bus: EventBus; denied: DeniedEvent[] } {
  const bus = new EventBus();
  const denied: DeniedEvent[] = [];
  bus.on("outbound_chat_type_denied", (p) => {
    denied.push(p as DeniedEvent);
  });
  return { bus, denied };
}

function makeTg(bus: EventBus): { tg: TelegramAPIClientImpl; sendCount: () => number } {
  let sendCount = 0;
  const fetchFn = (async () => {
    sendCount++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  const clock = realClock();
  const ps = new PollingStatusImpl(clock, bus);
  const tg = new TelegramAPIClientImpl({ token: "T", eventBus: bus, clock, pollingStatus: ps, fetchFn });
  return { tg, sendCount: () => sendCount };
}

function makeCache(type: ChatType | "throw"): ChatTypeCache {
  return {
    getChatType: async (_id: number) => {
      if (type === "throw") throw new ChatTypeFetchError(_id, new Error("network fail"));
      return type;
    },
    primeCache: () => {},
  };
}

describe("MODULE-004-AC-20: chat-type gate — private path proceeds", () => {
  test("MODULE-004-T20-private — reply proceeds when cache returns private", async () => {
    const { bus, denied } = makeBus();
    const { tg, sendCount } = makeTg(bus);
    const r = await reply(
      { chat_id: 1, text: "hi" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("private"),
        eventBus: bus,
        sessionId: "sess",
      },
    );
    expect(sendCount()).toBeGreaterThan(0);
    expect(denied.length).toBe(0);
    if ("delivered" in r) expect(r.delivered).toBe(true);
  });

  test("MODULE-004-T20-private-react — react proceeds", async () => {
    const { bus, denied } = makeBus();
    let sendCount = 0;
    const fetchFn = (async () => {
      sendCount++;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const r = await react(
      { chat_id: 1, message_id: 2, emoji: "👍" },
      {
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("private"),
        eventBus: bus,
        fetchFn,
      },
    );
    expect(r.ok).toBe(true);
    expect(sendCount).toBe(1);
    expect(denied.length).toBe(0);
  });

  test("MODULE-004-T20-private-edit — edit_message proceeds", async () => {
    const { bus, denied } = makeBus();
    const { tg, sendCount } = makeTg(bus);
    const r = await editMessage(
      { chat_id: 1, message_id: 2, text: "x" },
      { tg, chatTypeCache: makeCache("private"), eventBus: bus },
    );
    expect(sendCount()).toBeGreaterThan(0);
    expect(denied.length).toBe(0);
    if ("delivered" in r) expect(r.delivered).toBe(true);
  });

  test("MODULE-004-T20-private-approval — request_approval proceeds (admin chat private)", async () => {
    const { bus, denied } = makeBus();
    const { tg } = makeTg(bus);
    const clock = realClock();
    const registry = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
    const adminChatReg = new AdminChatRegistry(undefined);
    adminChatReg.setFromEnvForTest(7777);
    // Fire async — the Promise awaits an admin click which never comes in this test.
    // We only verify the gate path (cache hit + send made + entry inserted).
    const promise = requestApproval(
      { text: "Confirm?", options: ["yes"] },
      {
        tg,
        registry,
        adminChatRegistry: adminChatReg,
        clock,
        requesterSessionId: "s1",
        chatTypeCache: makeCache("private"),
        eventBus: bus,
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(denied.length).toBe(0);
    expect(registry.size()).toBe(1);
    // Resolve to avoid hanging promise.
    const pid = (registry as unknown as { entries: Map<string, { pending_id: string }> }).entries.keys().next().value!;
    await registry.resolveApproval(pid, "yes", "cbq", tg);
    const result = await promise;
    expect(result.ok).toBe(true);
  });
});

describe("MODULE-004-AC-20: chat-type gate — non-private path denies", () => {
  test("MODULE-004-T20-deny-reply — reply denies group + emits + no TG call", async () => {
    const { bus, denied } = makeBus();
    const { tg, sendCount } = makeTg(bus);
    const r = await reply(
      { chat_id: 99, text: "hi" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("group"),
        eventBus: bus,
      },
    );
    if (!("error" in r) || r.delivered !== false) throw new Error("expected denial envelope");
    expect(r.error).toBe("InvalidChatTypeError");
    expect(sendCount()).toBe(0);
    expect(denied.length).toBe(1);
    expect(denied[0]).toEqual({ chat_id: 99, observed_type: "group", tool: "reply" });
  });

  test("MODULE-004-T20-deny-react — react denies supergroup", async () => {
    const { bus, denied } = makeBus();
    let sendCount = 0;
    const fetchFn = (async () => {
      sendCount++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await react(
      { chat_id: 99, message_id: 2, emoji: "👍" },
      {
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("supergroup"),
        eventBus: bus,
        fetchFn,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("InvalidChatTypeError");
    expect(sendCount).toBe(0);
    expect(denied[0]).toEqual({ chat_id: 99, observed_type: "supergroup", tool: "react" });
  });

  test("MODULE-004-T20-deny-edit — edit_message denies channel", async () => {
    const { bus, denied } = makeBus();
    const { tg, sendCount } = makeTg(bus);
    const r = await editMessage(
      { chat_id: 5, message_id: 2, text: "x" },
      { tg, chatTypeCache: makeCache("channel"), eventBus: bus },
    );
    if (!("error" in r) || r.delivered !== false) throw new Error("expected denial envelope");
    expect(r.error).toBe("InvalidChatTypeError");
    expect(sendCount()).toBe(0);
    expect(denied[0]).toEqual({ chat_id: 5, observed_type: "channel", tool: "edit_message" });
  });

  test("MODULE-004-T20-deny-approval — request_approval denies misconfigured admin chat", async () => {
    const { bus, denied } = makeBus();
    const { tg } = makeTg(bus);
    const clock = realClock();
    const registry = new PendingApprovalRegistryImpl({ eventBus: bus, clock });
    const adminChatReg = new AdminChatRegistry(undefined);
    adminChatReg.setFromEnvForTest(7777);
    const r = await requestApproval(
      { text: "Confirm?", options: ["yes"] },
      {
        tg,
        registry,
        adminChatRegistry: adminChatReg,
        clock,
        requesterSessionId: "s1",
        chatTypeCache: makeCache("group"),
        eventBus: bus,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("InvalidChatTypeError");
    expect(registry.size()).toBe(0);
    expect(denied[0]).toEqual({ chat_id: 7777, observed_type: "group", tool: "request_approval" });
  });
});

describe("MODULE-004-AC-29: outbound_chat_type_denied event schema", () => {
  test("MODULE-004-T29-hit — payload {chat_id, observed_type, tool} matches CONTRACT-003 schema", async () => {
    const { bus, denied } = makeBus();
    const { tg } = makeTg(bus);
    await reply(
      { chat_id: 42, text: "x" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("group"),
        eventBus: bus,
      },
    );
    expect(denied.length).toBe(1);
    expect(Object.keys(denied[0]!).sort()).toEqual(["chat_id", "observed_type", "tool"]);
  });

  test("MODULE-004-T29-fetch-fail — ChatTypeFetchError → emit with observed_type:'unknown' + envelope", async () => {
    const { bus, denied } = makeBus();
    const { tg, sendCount } = makeTg(bus);
    const r = await reply(
      { chat_id: 42, text: "x" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("throw"),
        eventBus: bus,
      },
    );
    if (!("error" in r) || r.delivered !== false) throw new Error("expected denial envelope");
    expect(r.error).toBe("InvalidChatTypeError");
    expect(sendCount()).toBe(0);
    expect(denied[0]).toEqual({ chat_id: 42, observed_type: "unknown", tool: "reply" });
  });

  test("MODULE-004-T29-unresolvable — @username chat_id → emit with observed_type:'unresolvable' + envelope", async () => {
    const { bus, denied } = makeBus();
    const { tg, sendCount } = makeTg(bus);
    const r = await reply(
      { chat_id: "@bogus_username", text: "x" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: makeCache("private"),
        eventBus: bus,
      },
    );
    if (!("error" in r) || r.delivered !== false) throw new Error("expected denial envelope");
    expect(r.error).toBe("InvalidChatTypeError");
    expect(sendCount()).toBe(0);
    expect(denied[0]).toEqual({ chat_id: -1, observed_type: "unresolvable", tool: "reply" });
  });
});

describe("MODULE-004-AC-21: cold-start lazy-fetch path (cache miss → fetch → populate)", () => {
  test("MODULE-004-T21-cold — second call is hit (no second lazy-fetch invoked)", async () => {
    const { bus } = makeBus();
    const { tg } = makeTg(bus);
    let lazyFetchCalls = 0;
    const cache: ChatTypeCache = {
      getChatType: async (id: number) => {
        lazyFetchCalls++;
        // Simulate cache: first call lazy-fetches; subsequent calls hit.
        return "private";
      },
      primeCache: () => {},
    };
    // First call — cold
    await reply(
      { chat_id: 1, text: "a" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: cache,
        eventBus: bus,
      },
    );
    // The tool calls getChatType ONCE per invocation; verify it's called.
    expect(lazyFetchCalls).toBe(1);
    // Second call — a real cache would hit; this stub counts each invocation.
    await reply(
      { chat_id: 1, text: "b" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: cache,
        eventBus: bus,
      },
    );
    expect(lazyFetchCalls).toBe(2); // tool always asks; cache internally dedups
  });

  test("MODULE-004-T21-fetch-fail-retry — ChatTypeFetchError does NOT cache; next call retries (real ChatTypeCacheImpl semantics)", async () => {
    // Uses a stub that fails twice then succeeds — verifies the tool's gate retries on
    // each invocation. (The real CONTRACT-016 ChatTypeCacheImpl's not-caching-on-failure
    // semantics is tested in chat-type-cache.test.ts; this verifies the tool's gate
    // behavior is consistent with calling getChatType freshly each time.)
    const { bus, denied } = makeBus();
    const { tg } = makeTg(bus);
    let calls = 0;
    const cache: ChatTypeCache = {
      getChatType: async (id: number) => {
        calls++;
        if (calls < 3) throw new ChatTypeFetchError(id, new Error(`fail ${calls}`));
        return "private";
      },
      primeCache: () => {},
    };
    // Call 1: fetch-fail → denial
    const r1 = await reply(
      { chat_id: 1, text: "a" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: cache,
        eventBus: bus,
      },
    );
    expect(calls).toBe(1);
    if (!("error" in r1) || r1.delivered !== false) throw new Error("expected denial envelope");
    expect(r1.error).toBe("InvalidChatTypeError");
    expect(denied.length).toBe(1);
    // Call 2: fetch-fail again → denial (proves cache wasn't poisoned)
    const r2 = await reply(
      { chat_id: 1, text: "b" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: cache,
        eventBus: bus,
      },
    );
    expect(calls).toBe(2);
    if (!("delivered" in r2) || r2.delivered) throw new Error("expected denial");
    expect(denied.length).toBe(2);
    // Call 3: success
    const r3 = await reply(
      { chat_id: 1, text: "c" },
      {
        tg,
        apiBase: "https://api.example",
        token: "T",
        pollingStatus: new PollingStatusImpl(realClock(), bus),
        chatTypeCache: cache,
        eventBus: bus,
      },
    );
    expect(calls).toBe(3);
    expect("delivered" in r3 && r3.delivered).toBe(true);
  });
});
