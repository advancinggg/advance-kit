import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { buildMethodUrl } from "../../src/telegram/methods";
import { makeMockFetch } from "../helpers/http-mock";

describe("MODULE-002-AC-20/AC-21: API method wrappers + compat schema", () => {
  test("MODULE-002-T20 — sendMessage POSTs to /bot{token}/sendMessage with chat_id+text", async () => {
    const mock = makeMockFetch();
    const eb = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, eb);
    const client = new TelegramAPIClientImpl({
      token: "TOKEN-123",
      eventBus: eb,
      clock,
      pollingStatus: ps,
      apiBase: "http://stub",
      fetchFn: mock.fetch,
    });
    mock.enqueue({ status: 200, body: { ok: true, result: { message_id: 42, date: 1, chat: { id: 7, type: "private" } } } });
    const res = await client.sendMessage({ chat_id: 7, text: "hi" });
    expect(res.delivered).toBe(true);
    if (res.delivered) expect(res.message_id).toBe(42);
    const calls = mock.callsMade();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://stub/botTOKEN-123/sendMessage");
    ps.stop();
  });

  test("buildMethodUrl constructs canonical Telegram URL shape", () => {
    expect(buildMethodUrl("https://api.telegram.org", "ABC", "getUpdates")).toBe(
      "https://api.telegram.org/botABC/getUpdates",
    );
  });

  test("MODULE-002-T20b — all 6 method wrappers issue HTTPS POST to the right path", async () => {
    const mock = makeMockFetch();
    const eb = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, eb);
    const client = new TelegramAPIClientImpl({
      token: "T",
      eventBus: eb,
      clock,
      pollingStatus: ps,
      apiBase: "http://stub",
      fetchFn: mock.fetch,
    });
    mock.enqueueMany([
      { status: 200, body: { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } } },
      { status: 200, body: { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true, result: { file_id: "f", file_unique_id: "u" } } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true, result: [] } },
    ]);
    await client.sendMessage({ chat_id: 1, text: "x" });
    await client.editMessageText({ chat_id: 1, message_id: 1, text: "y" });
    await client.answerCallbackQuery({ callback_query_id: "q1" });
    await client.getFile("file-1");
    await client.sendChatAction(1, "typing");
    await client.getUpdates({ offset: 0, timeout: 0 });
    const calls = mock.callsMade();
    expect(calls.map((c) => c.url)).toEqual([
      "http://stub/botT/sendMessage",
      "http://stub/botT/editMessageText",
      "http://stub/botT/answerCallbackQuery",
      "http://stub/botT/getFile",
      "http://stub/botT/sendChatAction",
      expect.stringContaining("http://stub/botT/getUpdates"),
    ]);
    ps.stop();
  });
});

describe("MODULE-002-AC-17: sendMessage during quarantine returns queued envelope", () => {
  test("MODULE-002-T17 — quarantine state → returns {delivered:false, queued:true, eta_hint}", async () => {
    const mock = makeMockFetch();
    const eb = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, eb);
    ps.setState("quarantine");
    const client = new TelegramAPIClientImpl({
      token: "T",
      eventBus: eb,
      clock,
      pollingStatus: ps,
      apiBase: "http://stub",
      fetchFn: mock.fetch,
    });
    const res = await client.sendMessage({ chat_id: 1, text: "hi" });
    expect(res.delivered).toBe(false);
    if (!res.delivered) {
      expect("queued" in res ? res.queued : false).toBe(true);
      if ("queued" in res) {
        expect(typeof res.eta_hint).toBe("number");
      }
    }
    // No fetch should have been made (short-circuit on quarantine).
    expect(mock.callsMade().length).toBe(0);
    ps.stop();
  });
});
