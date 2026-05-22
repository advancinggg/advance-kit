import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { reply } from "../../src/tools/reply";
import { makeMockFetch } from "../helpers/http-mock";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function mkFakeFile(): string {
  const id = randomBytes(4).toString("hex");
  const p = path.join(os.tmpdir(), `tgcp-test-reply-${id}.png`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header bytes
  cleanups.push(() => fs.rmSync(p, { force: true }));
  return p;
}

describe("MODULE-004-AC-01/AC-02: reply tool", () => {
  test("MODULE-004-T01 — text-only reply dispatches to M002.sendMessage; returns delivered envelope", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: { message_id: 42, date: 0, chat: { id: 1, type: "private" } } },
    });
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const r = await reply(
      { chat_id: 1, text: "hi" },
      {
        tg,
        apiBase: "https://api.example",
        token: "test:token",
        pollingStatus: ps,
        chatTypeCache: { getChatType: async () => "private", primeCache: () => {} },
        eventBus: bus,
        fetchFn: mock.fetch,
      },
    );
    if (!("delivered" in r) || r.delivered !== true) throw new Error("expected delivered:true");
    expect(r.message_id).toBe(42);
    const calls = mock.callsMade();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/sendMessage");
  });

  test("MODULE-004-T03 — reply with files routes via multipart sendPhoto for image extension", async () => {
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: { message_id: 99, date: 0, chat: { id: 1, type: "private" } } },
    });
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const filePath = mkFakeFile();
    const r = await reply(
      { chat_id: 1, text: "screenshot", files: [filePath] },
      {
        tg,
        apiBase: "https://api.example",
        token: "test:token",
        pollingStatus: ps,
        chatTypeCache: { getChatType: async () => "private", primeCache: () => {} },
        eventBus: bus,
        fetchFn: mock.fetch,
      },
    );
    if (!("delivered" in r) || r.delivered !== true) throw new Error("expected delivered:true");
    expect(r.message_id).toBe(99);
    const calls = mock.callsMade();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/sendPhoto");
  });
});
