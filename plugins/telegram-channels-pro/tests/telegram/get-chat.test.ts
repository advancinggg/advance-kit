import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { makeMockFetch } from "../helpers/http-mock";
import { EventCollector } from "../helpers/event-collector";

function makeClient(): {
  client: TelegramAPIClientImpl;
  mock: ReturnType<typeof makeMockFetch>;
  bus: EventBus;
  ps: PollingStatusImpl;
  collector: EventCollector;
} {
  const mock = makeMockFetch();
  const bus = new EventBus();
  const collector = new EventCollector(bus);
  const clock = realClock();
  const ps = new PollingStatusImpl(clock, bus);
  const client = new TelegramAPIClientImpl({
    token: "TOKEN",
    eventBus: bus,
    clock,
    pollingStatus: ps,
    apiBase: "http://stub",
    fetchFn: mock.fetch,
  });
  return { client, mock, bus, ps, collector };
}

describe("MODULE-002-AC-22: getChat method wrapper (REQ-035 cold-start lazy-fetch)", () => {
  test("MODULE-002-T22a — happy path returns {ok:true, result:{id,type}} envelope", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 200, body: { ok: true, result: { id: 12345, type: "private", first_name: "ignored" } } });
    const env = await client.getChat(12345);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.result.id).toBe(12345);
      expect(env.result.type).toBe("private");
      // Result is filtered to just {id, type}; extra fields like first_name are not propagated.
      expect((env.result as unknown as Record<string, unknown>).first_name).toBeUndefined();
    }
    const calls = mock.callsMade();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://stub/botTOKEN/getChat");
    // JSON body convention (matches §2.4): content-type application/json + JSON.stringify body.
    const init = calls[0]!.init as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ chat_id: 12345 }));
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T22b — HTTP 5xx returns {ok:false, error:'http_503'}", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 503, body: { ok: false } });
    const env = await client.getChat(99);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toBe("http_503");
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T22c — fetchFn throws returns {ok:false, error:'fetch_failed'}", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 0, throwError: { code: "ECONNRESET", message: "boom" } });
    const env = await client.getChat(7);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toBe("fetch_failed");
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T22d — Telegram-reported ok:false propagates description as error", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 200, body: { ok: false, description: "chat not found" } });
    const env = await client.getChat(42);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toBe("chat not found");
    ps.stop();
    collector.stop();
  });
});
