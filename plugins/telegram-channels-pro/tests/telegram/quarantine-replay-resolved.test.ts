import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { encodeFrame, FrameDecoder } from "../../src/mcp/frame";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import type { QuarantineReplyResolvedNotificationFrame, SessionInitFrame } from "../../src/mcp/frame-types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* ignore */ }
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
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

describe("MODULE-002-AC-31: quarantine_replay_resolved payload schema (REQ-045 + Decision A18)", () => {
  test("MODULE-002-T31a — schema delivers across CONTRACT-003 with all required fields", async () => {
    // Synthetic emission verifies the contract surface (CONTRACT-003 event-type catalog +
    // M003 daemon-acceptor subscription forward). The producer side (M002 drain on
    // quarantine_exit) is AC-29 (REQ-037) and not in this slice's scope.
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

    // Connect a client, send session_init, capture session_id from session_connected event.
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
    const initFrame: SessionInitFrame = {
      kind: "session_init",
      shortid: "test1234",
      branch: "main",
    };
    sock.write(Buffer.from(encodeFrame(initFrame)));
    await waitFor(() => proxySessionId !== null);

    // Capture daemon→client frames.
    const decoder = new FrameDecoder(1_048_576);
    const receivedFrames: unknown[] = [];
    sock.on("data", (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const r = decoder.push(u8);
      for (const f of r.frames) receivedFrames.push(f);
    });

    // Synthetically emit the quarantine_replay_resolved event into the EventBus.
    const payload = {
      requester_session: proxySessionId!,
      message_id: 12345,
      delivered: true,
      queued_at: 1_700_000_000_000,
      replayed_at: 1_700_000_001_500,
    };
    tmp.eventBus.emit("quarantine_replay_resolved", payload);

    // Wait for the daemon to forward as a UDS frame.
    await waitFor(() => receivedFrames.some((f) => (f as { kind?: string }).kind === "quarantine_reply_resolved"));
    const fwd = receivedFrames.find(
      (f) => (f as { kind?: string }).kind === "quarantine_reply_resolved",
    ) as QuarantineReplyResolvedNotificationFrame;

    // Full payload schema verification.
    expect(fwd.requester_session).toBe(proxySessionId!);
    expect(fwd.message_id).toBe(12345);
    expect(fwd.delivered).toBe(true);
    expect(fwd.queued_at).toBe(1_700_000_000_000);
    expect(fwd.replayed_at).toBe(1_700_000_001_500);
  });

  test("MODULE-002-T31b — optional error_class field is forwarded when present (failure case)", async () => {
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
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "test1234", branch: "main" })));
    await waitFor(() => proxySessionId !== null);

    const decoder = new FrameDecoder(1_048_576);
    const receivedFrames: unknown[] = [];
    sock.on("data", (chunk: Buffer) => {
      const r = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      for (const f of r.frames) receivedFrames.push(f);
    });

    tmp.eventBus.emit("quarantine_replay_resolved", {
      requester_session: proxySessionId!,
      delivered: false,
      queued_at: 1_700_000_000_000,
      replayed_at: 1_700_000_001_500,
      error_class: "rate_limited_429",
    });

    await waitFor(() => receivedFrames.some((f) => (f as { kind?: string }).kind === "quarantine_reply_resolved"));
    const fwd = receivedFrames.find(
      (f) => (f as { kind?: string }).kind === "quarantine_reply_resolved",
    ) as QuarantineReplyResolvedNotificationFrame;
    expect(fwd.delivered).toBe(false);
    expect(fwd.error_class).toBe("rate_limited_429");
  });
});
