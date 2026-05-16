import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { realClock } from "../../src/daemon/clock";
import { EventCollector } from "../helpers/event-collector";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { encodeFrame, FrameDecoder } from "../../src/mcp/frame";
import { isChannelNotificationFrame, type ChannelNotificationFrame, type SessionInitFrame } from "../../src/mcp/frame-types";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* ignore */ }
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function setupAcceptorAndSession(): Promise<{
  acceptor: MCPDaemonAcceptor;
  bus: ReturnType<typeof makeTmpStateDir>["eventBus"];
  socketPath: string;
  proxySessionId: string;
  clientSock: net.Socket;
  receivedFrames: unknown[];
  collector: EventCollector;
}> {
  const tmp = makeTmpStateDir();
  cleanups.push(tmp.cleanup);
  await tmp.stateDir.initialize();
  const acceptor = new MCPDaemonAcceptor({
    eventBus: tmp.eventBus,
    stateDir: tmp.stateDir,
    clock: realClock(),
    sessionInitTimeoutMs: 2000,
  });
  await acceptor.start();
  cleanups.push(() => acceptor.stop());

  let proxySessionId: string | null = null;
  const unsub = tmp.eventBus.on("session_connected", (p) => {
    proxySessionId = p.session_id;
  });
  cleanups.push(() => unsub());

  const sock = net.connect({ path: tmp.stateDir.socketFile });
  cleanups.push(() => { try { sock.destroy(); } catch { /* ignore */ } });
  await new Promise<void>((res, rej) => {
    sock.once("connect", () => res());
    sock.once("error", rej);
  });

  const decoder = new FrameDecoder(1_048_576);
  const receivedFrames: unknown[] = [];
  sock.on("data", (chunk: Buffer) => {
    const r = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    for (const f of r.frames) receivedFrames.push(f);
  });

  const initFrame: SessionInitFrame = { kind: "session_init", shortid: "test1234", branch: "main" };
  sock.write(Buffer.from(encodeFrame(initFrame)));
  await waitFor(() => proxySessionId !== null);

  const collector = new EventCollector(tmp.eventBus);
  cleanups.push(() => collector.stop());

  return {
    acceptor,
    bus: tmp.eventBus,
    socketPath: tmp.stateDir.socketFile,
    proxySessionId: proxySessionId!,
    clientSock: sock,
    receivedFrames,
    collector,
  };
}

describe("MODULE-003-AC-19: deliverChannelNotification daemon-side UDS frame emit (REQ-033)", () => {
  test("MODULE-003-T19a — daemon writes ChannelNotificationFrame to the session socket on call", async () => {
    const { acceptor, proxySessionId, receivedFrames } = await setupAcceptorAndSession();

    const payload = { text: "hello", image_path: "/tmp/img.jpg" };
    const meta = { chat_id: 9876, message_id: 12345, user: "alice", ts: 1_700_000_000 };
    const res = await acceptor.deliverChannelNotification(proxySessionId, payload, meta);
    expect(res.ok).toBe(true);

    await waitFor(() => receivedFrames.some((f) => isChannelNotificationFrame(f)));
    const fwd = receivedFrames.find((f) => isChannelNotificationFrame(f)) as ChannelNotificationFrame;
    expect(fwd.text).toBe("hello");
    expect(fwd.image_path).toBe("/tmp/img.jpg");
    expect(fwd.chat_id).toBe(9876);
    expect(fwd.message_id).toBe(12345);
    expect(fwd.user).toBe("alice");
    expect(fwd.ts).toBe(1_700_000_000);
  });
});

describe("MODULE-003-AC-20: deliverChannelNotification unknown session emits error log (REQ-033)", () => {
  test("MODULE-003-T20 — unknown session_id → log_emit ERROR + no socket write", async () => {
    const { acceptor, receivedFrames, collector } = await setupAcceptorAndSession();
    receivedFrames.length = 0;
    collector.clear();

    const res = await acceptor.deliverChannelNotification(
      "nonexistent-session-id",
      { text: "no session" },
      { chat_id: 1, message_id: 2, user: "x", ts: 0 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("unknown_session");

    // log_emit ERROR with event_type: unknown_session_in_deliverChannelNotification
    const logs = collector.byType("log_emit");
    const matching = logs.find((e) => {
      const p = e.payload as { event_type?: string; level?: string };
      return p.event_type === "unknown_session_in_deliverChannelNotification" && p.level === "ERROR";
    });
    expect(matching).toBeDefined();

    // No channel_notification frame should reach the connected client.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(receivedFrames.some((f) => isChannelNotificationFrame(f))).toBe(false);
  });
});

describe("MODULE-003-AC-28: channel_notification_emitted event fires on success (REQ-033)", () => {
  test("MODULE-003-T28 — successful deliverChannelNotification emits channel_notification_emitted", async () => {
    const { acceptor, proxySessionId, collector } = await setupAcceptorAndSession();
    collector.clear();

    await acceptor.deliverChannelNotification(
      proxySessionId,
      { text: "hi" },
      { chat_id: 7777, message_id: 8888, user: "bob", ts: 1_700_000_000 },
    );

    const events = collector.byType("channel_notification_emitted");
    expect(events.length).toBe(1);
    const payload = events[0]!.payload as { session_id: string; chat_id: number; message_id: number };
    expect(payload.session_id).toBe(proxySessionId);
    expect(payload.chat_id).toBe(7777);
    expect(payload.message_id).toBe(8888);
  });
});
