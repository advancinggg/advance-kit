import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { JsonLogger } from "../../src/obs/json-logger";
import { AlertDispatcher } from "../../src/obs/alert-dispatcher";
import type { TelegramAPIClient } from "../../src/telegram/client";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeStubTgClient(): { client: TelegramAPIClient; sentMessages: Array<{ chat_id: number | string; text: string }> } {
  const sent: Array<{ chat_id: number | string; text: string }> = [];
  const client: TelegramAPIClient = {
    async sendMessage(req) {
      sent.push({ chat_id: req.chat_id, text: req.text });
      return { delivered: true, message_id: sent.length, result: { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } };
    },
    async editMessageText() {
      return { delivered: false, error: "disconnected", reason: "stub" };
    },
    async answerCallbackQuery() {
      return { ok: true };
    },
    async getFile() {
      return { ok: false, error: "stub" };
    },
    async sendChatAction() {
      return { ok: true };
    },
    async getUpdates() {
      return { ok: true, result: [], classified: { kind: "ok" } };
    },
    async getChat() {
      return { ok: false, error: "stub" };
    },
  };
  return { client, sentMessages: sent };
}

function setup() {
  const dir = path.join(os.tmpdir(), `tgcp-alert-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clock = fakeClock(0);
  const eb = new EventBus();
  const logger = new JsonLogger({ logDir: dir, clock });
  logger.start();
  const dispatcher = new AlertDispatcher({ eventBus: eb, clock, logger });
  cleanups.push(() => {
    logger.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { eb, clock, logger, dispatcher, dir };
}

describe("MODULE-008-AC-09: edge-triggered quarantine alerts", () => {
  test("MODULE-008-T09 — quarantine_enter + quarantine_exit → exactly 2 alerts; conflict_409 events between do NOT add", async () => {
    const { eb, dispatcher } = setup();
    const stub = makeStubTgClient();
    dispatcher.setTgClient(stub.client, 999);
    // Feed events synchronously.
    dispatcher.feedEvent("quarantine_enter", { reason: "x", count_in_window: 5, window_ms: 60_000 });
    for (let i = 0; i < 10; i++) {
      dispatcher.feedEvent("polling_event", { kind: "conflict_409" });
    }
    dispatcher.feedEvent("quarantine_exit", { recovered_after_ms: 5000 });
    // Wait for the async flushQueue to complete.
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(stub.sentMessages.length).toBe(2);
    expect(stub.sentMessages[0]!.text).toContain("quarantine_enter");
    expect(stub.sentMessages[1]!.text).toContain("quarantine_exit");
  });
});

describe("MODULE-008-AC-10: one-shot terminal watchdog alert", () => {
  test("MODULE-008-T10 — watchdog_signal severity=failure → exactly 1 alert", async () => {
    const { dispatcher } = setup();
    const stub = makeStubTgClient();
    dispatcher.setTgClient(stub.client, 999);
    dispatcher.feedEvent("watchdog_signal", { kind: "orphan", severity: "failure", detail: {} });
    // Send another watchdog_signal (same kind) — should NOT re-alert (one-shot).
    dispatcher.feedEvent("watchdog_signal", { kind: "orphan", severity: "failure", detail: {} });
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(stub.sentMessages.length).toBe(1);
    expect(stub.sentMessages[0]!.text).toContain("watchdog:orphan");
  });
});

describe("MODULE-008-AC-11: token-bucket rate-limited auth_deny alerts", () => {
  test("MODULE-008-T11 — auth_deny_routing same sender 5 times within 10min → 1 alert (first only)", async () => {
    const { dispatcher } = setup();
    const stub = makeStubTgClient();
    dispatcher.setTgClient(stub.client, 999);
    for (let i = 0; i < 5; i++) {
      dispatcher.feedEvent("auth_deny_routing", { sender_hash: "alice123", reason: "non_admin" });
    }
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(stub.sentMessages.length).toBe(1);
  });

  test("MODULE-008-T11b — different sender_hash → independent buckets", async () => {
    const { dispatcher } = setup();
    const stub = makeStubTgClient();
    dispatcher.setTgClient(stub.client, 999);
    dispatcher.feedEvent("auth_deny_routing", { sender_hash: "alice", reason: "r" });
    dispatcher.feedEvent("auth_deny_routing", { sender_hash: "bob", reason: "r" });
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(stub.sentMessages.length).toBe(2);
  });
});

describe("MODULE-008-AC-12: crash-restart merge window", () => {
  test("MODULE-008-T12 — 3 daemon_start events within 5min → ONE merged alert at window expiry", async () => {
    const { eb: _eb, clock, dispatcher } = setup();
    const stub = makeStubTgClient();
    dispatcher.setTgClient(stub.client, 999);
    dispatcher.feedEvent("daemon_start", { pid: 1, boot_ts: 0, bun_version: "1", deployment_mode: "lazy-spawn" });
    dispatcher.feedEvent("daemon_start", { pid: 2, boot_ts: 1, bun_version: "1", deployment_mode: "lazy-spawn" });
    dispatcher.feedEvent("daemon_start", { pid: 3, boot_ts: 2, bun_version: "1", deployment_mode: "lazy-spawn" });
    // Advance time past the merge window.
    clock.tick(5 * 60_000 + 1);
    await new Promise<void>((res) => setTimeout(res, 30));
    const merged = stub.sentMessages.filter((m) => m.text.includes("daemon_crash_restart_merged"));
    expect(merged.length).toBe(1);
  });

  test("MODULE-008-T12b — single daemon_start (no merge) → NO alert", async () => {
    const { clock, dispatcher } = setup();
    const stub = makeStubTgClient();
    dispatcher.setTgClient(stub.client, 999);
    dispatcher.feedEvent("daemon_start", { pid: 1, boot_ts: 0, bun_version: "1", deployment_mode: "lazy-spawn" });
    clock.tick(5 * 60_000 + 1);
    await new Promise<void>((res) => setTimeout(res, 30));
    const merged = stub.sentMessages.filter((m) => m.text.includes("daemon_crash_restart_merged"));
    expect(merged.length).toBe(0);
  });
});

describe("MODULE-008-AC-19: alert delivery failure logged", () => {
  test("MODULE-008-T19 — sendMessage returns disconnected → alert_delivery_failed logged, no crash", async () => {
    const { dispatcher, dir, clock, logger } = setup();
    void clock;
    const failingClient: TelegramAPIClient = {
      async sendMessage() {
        return { delivered: false, error: "disconnected", reason: "quarantine" };
      },
      async editMessageText() {
        return { delivered: false, error: "disconnected", reason: "stub" };
      },
      async answerCallbackQuery() {
        return { ok: true };
      },
      async getFile() {
        return { ok: false, error: "stub" };
      },
      async sendChatAction() {
        return { ok: true };
      },
      async getUpdates() {
        return { ok: true, result: [], classified: { kind: "ok" } };
      },
      async getChat() {
        return { ok: false, error: "stub" };
      },
    };
    dispatcher.setTgClient(failingClient, 999);
    dispatcher.feedEvent("watchdog_signal", { kind: "stuck", severity: "failure", detail: {} });
    await new Promise<void>((res) => setTimeout(res, 30));
    const logFile = logger.getCurrentFile();
    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toContain("alert_delivery_failed");
  });
});

describe("drainAlertsToLogOnly (Round 4 W1 fix)", () => {
  test("queued alerts before setTgClient are written to log with delivery='aborted' when drained", () => {
    const { dispatcher, logger } = setup();
    dispatcher.feedEvent("watchdog_signal", { kind: "stuck", severity: "failure", detail: {} });
    const drained = dispatcher.drainAlertsToLogOnly();
    expect(drained).toBeGreaterThanOrEqual(1);
    const content = fs.readFileSync(logger.getCurrentFile(), "utf8");
    expect(content).toContain("aborted");
  });
});
