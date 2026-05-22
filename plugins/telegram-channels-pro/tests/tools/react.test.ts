import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { react } from "../../src/tools/react";
import { makeMockFetch } from "../helpers/http-mock";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-004-AC-03: react tool", () => {
  test("MODULE-004-T04 — react POSTs to setMessageReaction with [{type:'emoji',emoji}] payload", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: true },
    });
    const r = await react(
      { chat_id: 1, message_id: 42, emoji: "👍" },
      {
        apiBase: "https://api.example",
        token: "test:token",
        pollingStatus: ps,
        chatTypeCache: { getChatType: async () => "private", primeCache: () => {} },
        eventBus: bus,
        fetchFn: mock.fetch,
      },
    );
    expect(r.ok).toBe(true);
    const calls = mock.callsMade();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/setMessageReaction");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.chat_id).toBe(1);
    expect(body.message_id).toBe(42);
    expect(body.reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
  });
});
