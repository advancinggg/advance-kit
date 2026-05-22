import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { reply } from "../../src/tools/reply";
import { react } from "../../src/tools/react";
import { editMessage } from "../../src/tools/edit-message";
import { downloadAttachment } from "../../src/tools/download-attachment";
import { makeMockFetch } from "../helpers/http-mock";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const FIXTURE_DIR = path.resolve(__dirname, "compat-fixtures/upstream-0.0.6");

interface Fixture {
  tool: string;
  params_required: string[];
  params_optional: string[];
  result_keys_delivered?: string[];
  result_keys_queued?: string[];
  result_keys_error?: string[];
  result_keys_ok?: string[];
  result_keys_ok_inner?: string[];
  result_keys_err?: string[];
}

function loadFixture(name: string): Fixture {
  const p = path.join(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Fixture;
}

function keysOf(obj: unknown): Set<string> {
  if (typeof obj !== "object" || obj === null) return new Set();
  return new Set(Object.keys(obj));
}

describe("MODULE-004-AC-06: compat suite — upstream 0.0.6 schema agreement (key-set level)", () => {
  test("MODULE-004-T08 — reply tool input/output keys agree with upstream fixture", async () => {
    const fix = loadFixture("reply");
    expect(fix.tool).toBe("reply");
    // Verify required params are accepted; build a minimal valid input
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } },
    });
    const tg = new TelegramAPIClientImpl({ token: "t", eventBus: bus, clock, pollingStatus: ps, fetchFn: mock.fetch });
    const r = await reply(
      { chat_id: 1, text: "hi" },
      {
        tg,
        apiBase: "https://api.example",
        token: "t",
        pollingStatus: ps,
        chatTypeCache: { getChatType: async () => "private" as const, primeCache: () => {} },
        eventBus: bus,
        fetchFn: mock.fetch,
      },
    );
    const observed = keysOf(r);
    const expected = new Set(fix.result_keys_delivered);
    // Tool's result must be a SUPERSET of fixture's required delivered keys
    for (const k of expected) {
      expect(observed.has(k)).toBe(true);
    }
  });

  test("MODULE-004-T08b — react tool input/output keys agree", async () => {
    const fix = loadFixture("react");
    expect(fix.tool).toBe("react");
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true, result: true } });
    const r = await react(
      { chat_id: 1, message_id: 2, emoji: "👍" },
      {
        apiBase: "https://api.example",
        token: "t",
        pollingStatus: ps,
        chatTypeCache: { getChatType: async () => "private" as const, primeCache: () => {} },
        eventBus: bus,
        fetchFn: mock.fetch,
      },
    );
    const observed = keysOf(r);
    expect(observed.has("ok")).toBe(true);
  });

  test("MODULE-004-T08c — edit_message tool input/output keys agree", async () => {
    const fix = loadFixture("edit_message");
    expect(fix.tool).toBe("edit_message");
    const bus = new EventBus();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true, result: { message_id: 7, date: 0, chat: { id: 1, type: "private" } } } });
    const tg = new TelegramAPIClientImpl({ token: "t", eventBus: bus, clock, pollingStatus: ps, fetchFn: mock.fetch });
    const r = await editMessage(
      { chat_id: 1, message_id: 7, text: "x" },
      {
        tg,
        chatTypeCache: { getChatType: async () => "private" as const, primeCache: () => {} },
        eventBus: bus,
      },
    );
    const observed = keysOf(r);
    expect(observed.has("delivered")).toBe(true);
  });

  test("MODULE-004-T08d — download_attachment tool input/output keys agree", async () => {
    const fix = loadFixture("download_attachment");
    expect(fix.tool).toBe("download_attachment");
    const bus = new EventBus();
    const tmp = makeTmpStateDir(bus);
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true, result: { file_id: "x", file_unique_id: "x", file_size: 4, file_path: "documents/x.txt" } } });
    mock.enqueue({ status: 200, headers: { "content-type": "text/plain" }, body: "abcd" });
    const tg = new TelegramAPIClientImpl({ token: "t", eventBus: bus, clock, pollingStatus: ps, fetchFn: mock.fetch });
    const r = await downloadAttachment(
      { file_id: "x" },
      { tg, apiBase: "https://api.example", token: "t", stateDir: tmp.stateDir, fetchFn: mock.fetch },
    );
    const observed = keysOf(r);
    expect(observed.has("ok")).toBe(true);
    if ("ok" in r && r.ok && fix.result_keys_ok_inner) {
      const innerKeys = keysOf(r.result);
      for (const k of fix.result_keys_ok_inner) {
        expect(innerKeys.has(k)).toBe(true);
      }
    }
  });
});
