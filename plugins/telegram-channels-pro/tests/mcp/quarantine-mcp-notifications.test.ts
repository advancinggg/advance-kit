import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { encodeFrame, FrameDecoder } from "../../src/mcp/frame";
import {
  isQuarantineReplyResolvedFrame,
  isQuarantineStateChangedFrame,
  type QuarantineReplyResolvedNotificationFrame,
  type QuarantineStateChangedFrame,
  type SessionInitFrame,
} from "../../src/mcp/frame-types";
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

async function startAcceptorAndConnectN(n: number): Promise<{
  acceptor: MCPDaemonAcceptor;
  bus: ReturnType<typeof makeTmpStateDir>["eventBus"];
  sessions: Array<{ sessionId: string; sock: net.Socket; receivedFrames: unknown[] }>;
}> {
  const tmp = makeTmpStateDir();
  cleanups.push(tmp.cleanup);
  await tmp.stateDir.initialize();
  const acceptor = new MCPDaemonAcceptor({
    eventBus: tmp.eventBus,
    stateDir: tmp.stateDir,
    clock: realClock(),
    sessionInitTimeoutMs: 60_000,
  });
  await acceptor.start();
  cleanups.push(() => acceptor.stop());

  const collectedSessions: Array<{ session_id: string }> = [];
  const unsub = tmp.eventBus.on("session_connected", (p) => collectedSessions.push({ session_id: p.session_id }));
  cleanups.push(() => unsub());

  const sessions: Array<{ sessionId: string; sock: net.Socket; receivedFrames: unknown[] }> = [];
  for (let i = 0; i < n; i++) {
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { try { sock.destroy(); } catch { /* ignore */ } });
    await new Promise<void>((res, rej) => { sock.once("connect", () => res()); sock.once("error", rej); });

    const decoder = new FrameDecoder(1_048_576);
    const receivedFrames: unknown[] = [];
    sock.on("data", (chunk: Buffer) => {
      const r = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      for (const f of r.frames) receivedFrames.push(f);
    });

    const initFrame: SessionInitFrame = { kind: "session_init", shortid: `s${i}abcdef`, branch: "main" };
    sock.write(Buffer.from(encodeFrame(initFrame)));
    await waitFor(() => collectedSessions.length >= i + 1);
    sessions.push({ sessionId: collectedSessions[i]!.session_id, sock, receivedFrames });
  }
  return { acceptor, bus: tmp.eventBus, sessions };
}

describe("MODULE-003-AC-25: quarantine_replay_resolved → MCP tgcp/quarantine/reply_resolved (REQ-037 + A18)", () => {
  test("MODULE-003-T25 — daemon forwards to requester_session ONLY (not broadcast)", async () => {
    const { bus, sessions } = await startAcceptorAndConnectN(2);
    const [s0, s1] = sessions;

    bus.emit("quarantine_replay_resolved", {
      requester_session: s0!.sessionId,
      message_id: 999,
      delivered: true,
      queued_at: 1_000,
      replayed_at: 2_000,
    });

    await waitFor(() => s0!.receivedFrames.some((f) => isQuarantineReplyResolvedFrame(f)));
    const fwd = s0!.receivedFrames.find((f) => isQuarantineReplyResolvedFrame(f)) as QuarantineReplyResolvedNotificationFrame;
    expect(fwd.requester_session).toBe(s0!.sessionId);
    expect(fwd.message_id).toBe(999);
    expect(fwd.delivered).toBe(true);

    // s1 must NOT receive it (per-session targeting, not broadcast).
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(s1!.receivedFrames.some((f) => isQuarantineReplyResolvedFrame(f))).toBe(false);
  });

  test("MODULE-003-T25b — unknown requester_session is silently dropped (no error, no broadcast)", async () => {
    const { bus, sessions } = await startAcceptorAndConnectN(1);

    bus.emit("quarantine_replay_resolved", {
      requester_session: "nonexistent-session-id",
      message_id: 999,
      delivered: false,
      queued_at: 1_000,
      replayed_at: 2_000,
      error_class: "session_terminated",
    });

    await new Promise<void>((r) => setTimeout(r, 50));
    expect(sessions[0]!.receivedFrames.some((f) => isQuarantineReplyResolvedFrame(f))).toBe(false);
  });
});

describe("MODULE-003-AC-26: quarantine_enter/exit → MCP tgcp/quarantine/state_changed (REQ-045 + A18)", () => {
  test("MODULE-003-T26a — quarantine_enter with eta_hint=45 broadcasts QuarantineStateChangedFrame to ALL sessions", async () => {
    const { bus, sessions } = await startAcceptorAndConnectN(3);

    bus.emit("quarantine_enter", {
      reason: "fatal_window_threshold",
      count_in_window: 5,
      window_ms: 60_000,
      eta_hint: 45,
    });

    for (const s of sessions) {
      await waitFor(() => s.receivedFrames.some((f) => isQuarantineStateChangedFrame(f)));
      const fwd = s.receivedFrames.find((f) => isQuarantineStateChangedFrame(f)) as QuarantineStateChangedFrame;
      expect(fwd.state).toBe("quarantine_enter");
      expect(fwd.eta_hint).toBe(45);
    }
  });

  test("MODULE-003-T26b — quarantine_exit with eta_hint=0 broadcasts to ALL sessions", async () => {
    const { bus, sessions } = await startAcceptorAndConnectN(2);

    bus.emit("quarantine_exit", { recovered_after_ms: 65_000, eta_hint: 0 });

    for (const s of sessions) {
      await waitFor(() => s.receivedFrames.some((f) => isQuarantineStateChangedFrame(f)));
      const fwd = s.receivedFrames.find((f) => isQuarantineStateChangedFrame(f)) as QuarantineStateChangedFrame;
      expect(fwd.state).toBe("quarantine_exit");
      expect(fwd.eta_hint).toBe(0);
    }
  });

  test("MODULE-003-T26 — eta_hint defaults to 0 when not present on the event payload", async () => {
    const { bus, sessions } = await startAcceptorAndConnectN(1);

    // Emit without eta_hint to verify the default-0 path.
    bus.emit("quarantine_enter", {
      reason: "fatal_window_threshold",
      count_in_window: 5,
      window_ms: 60_000,
    });

    await waitFor(() => sessions[0]!.receivedFrames.some((f) => isQuarantineStateChangedFrame(f)));
    const fwd = sessions[0]!.receivedFrames.find((f) => isQuarantineStateChangedFrame(f)) as QuarantineStateChangedFrame;
    expect(fwd.eta_hint).toBe(0);
  });
});

describe("MODULE-003-AC-25/26: proxy-side MCP-notification translation source-contract", () => {
  test("proxy-client handleFrame translates quarantine_reply_resolved + quarantine_state_changed → MCP notification", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/mcp/proxy-client.ts"), "utf8");
    expect(src).toContain('frame.kind === "quarantine_reply_resolved"');
    expect(src).toContain('"tgcp/quarantine/reply_resolved"');
    expect(src).toContain('frame.kind === "quarantine_state_changed"');
    expect(src).toContain('"tgcp/quarantine/state_changed"');
    // channel_notification path:
    expect(src).toContain('frame.kind === "channel_notification"');
    expect(src).toContain('"notifications/claude/channel"');
  });
});
