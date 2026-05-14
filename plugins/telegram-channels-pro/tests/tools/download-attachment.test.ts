import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { TelegramAPIClientImpl } from "../../src/telegram/client";
import { PollingStatusImpl } from "../../src/telegram/polling-status";
import { downloadAttachment } from "../../src/tools/download-attachment";
import { makeMockFetch } from "../helpers/http-mock";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-004-AC-05/AC-16: download_attachment tool", () => {
  test("MODULE-004-T06 — getFile + HTTPS download → file written under <state_dir>/attachments/ with 0600 perms", async () => {
    const bus = new EventBus();
    const tmp = makeTmpStateDir(bus);
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    // First call: getFile API → returns file_path
    mock.enqueue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, result: { file_id: "ABC", file_unique_id: "U", file_size: 4, file_path: "documents/file_123.txt" } },
    });
    // Second call: file content download
    mock.enqueue({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "abcd", // mock-fetch JSON-encodes string → 6 bytes ("abcd" with quotes); use raw bytes via text response trick
    });
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const r = await downloadAttachment(
      { file_id: "ABC" },
      { tg, apiBase: "https://api.example", token: "test:token", stateDir: tmp.stateDir, fetchFn: mock.fetch },
    );
    if (!("ok" in r) || r.ok !== true) throw new Error(`download failed: ${JSON.stringify(r)}`);
    expect(r.result.path).toContain(tmp.stateDir.attachmentDir);
    expect(r.result.path.endsWith(".txt")).toBe(true);
    const stat = fs.statSync(r.result.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("MODULE-004-T07 — getFile error → InvalidFileId", async () => {
    const bus = new EventBus();
    const tmp = makeTmpStateDir(bus);
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const clock = realClock();
    const ps = new PollingStatusImpl(clock, bus);
    const mock = makeMockFetch();
    mock.enqueue({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { ok: false, description: "Bad Request" },
    });
    const tg = new TelegramAPIClientImpl({
      token: "test:token",
      eventBus: bus,
      clock,
      pollingStatus: ps,
      fetchFn: mock.fetch,
    });
    const r = await downloadAttachment(
      { file_id: "BAD" },
      { tg, apiBase: "https://api.example", token: "test:token", stateDir: tmp.stateDir, fetchFn: mock.fetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("InvalidFileId");
  });
});
