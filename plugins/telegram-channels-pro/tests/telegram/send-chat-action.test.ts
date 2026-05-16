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

describe("MODULE-002-AC-33: sendChatAction fire-and-forget wrapper (REQ-033 + Decision A15)", () => {
  test("MODULE-002-T33a — sendChatAction('typing') POSTs to /bot{token}/sendChatAction", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 200, body: { ok: true, result: true } });
    const res = await client.sendChatAction(42, "typing");
    expect(res.ok).toBe(true);
    const calls = mock.callsMade();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://stub/botTOKEN/sendChatAction");
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T33b — sendChatAction on HTTP 429 returns {ok:false,error} without rethrow", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({
      status: 429,
      headers: { "retry-after": "3" },
      body: { ok: false, parameters: { retry_after: 3 } },
    });
    const res = await client.sendChatAction(42, "typing");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeDefined();
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T33b — sendChatAction on 5xx returns {ok:false} without rethrow", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 500, body: { ok: false, description: "internal" } });
    const res = await client.sendChatAction(42, "typing");
    expect(res.ok).toBe(false);
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T33b — sendChatAction on network error returns {ok:false} without rethrow", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 0, throwError: { code: "ECONNRESET", message: "reset" } });
    const res = await client.sendChatAction(42, "typing");
    expect(res.ok).toBe(false);
    ps.stop();
    collector.stop();
  });

  test("MODULE-002-T33c — sendChatAction failure does NOT emit alert_emit (Decision A15 isolation)", async () => {
    const { client, mock, ps, collector } = makeClient();
    mock.enqueue({ status: 500, body: { ok: false } });
    await client.sendChatAction(42, "typing");
    const alerts = collector.byType("alert_emit");
    expect(alerts.length).toBe(0);
    ps.stop();
    collector.stop();
  });
});
