import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { editMessage } from "../../src/tools/edit-message";
import { makeMockFetch } from "../helpers/http-mock";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-004-AC-04: edit_message tool", () => {
  test("MODULE-004-T05 — edit_message calls tg.editMessageText with chat_id+message_id+text", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: { message_id: 7, date: 0, chat: { id: 1, type: "private" } } },
    });
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const r = await editMessage({ chat_id: 1, message_id: 7, text: "updated" }, { tg });
    if (!("delivered" in r) || r.delivered !== true) throw new Error("expected delivered:true");
    expect(r.message_id).toBe(7);
    const calls = mock.callsMade();
    expect(calls[0]!.url).toContain("/editMessageText");
  });
});
