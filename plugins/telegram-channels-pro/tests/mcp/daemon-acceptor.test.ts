import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { realClock } from "../../src/daemon/clock";
import { encodeFrame, MAX_FRAME_BYTES } from "../../src/mcp/frame";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch {
      /* ignore */
    }
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

async function connectAndSend(socketPath: string, frame: Uint8Array): Promise<net.Socket> {
  const sock = net.connect({ path: socketPath });
  await new Promise<void>((res, rej) => {
    sock.once("connect", () => res());
    sock.once("error", rej);
  });
  sock.write(Buffer.from(frame));
  return sock;
}

describe("MODULE-003-AC-01: UDS bind + 0600 perms", () => {
  test("MODULE-003-T01 — daemon-side acceptor binds UDS at stateDir.socketFile with 0600 perms", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    expect(fs.existsSync(tmp.stateDir.socketFile)).toBe(true);
    const stat = fs.statSync(tmp.stateDir.socketFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("MODULE-003-AC-03: session_connected on session_init frame", () => {
  test("MODULE-003-T03 — successful session_init emits session_connected with 16-hex session_id", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = await connectAndSend(tmp.stateDir.socketFile, encodeFrame({ kind: "session_init", shortid: "abc1234" }));
    await waitFor(() => collector.byType("session_connected").length > 0, 2000);
    const evt = collector.byType("session_connected")[0]!;
    const p = evt.payload as { session_id: string; shortid: string };
    expect(p.session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(p.shortid).toBe("abc1234");
    sock.destroy();
    collector.stop();
  });
});

describe("MODULE-003-AC-07: pre-init frame rejected", () => {
  test("MODULE-003-T07 — sending tool_call before session_init → frame_invalid:pre_init + connection close", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = await connectAndSend(
      tmp.stateDir.socketFile,
      encodeFrame({ kind: "tool_call", request_id: "r1", tool: "reply", params: {} }),
    );
    await waitFor(() => collector.byType("frame_invalid").length > 0, 2000);
    const inv = collector.byType("frame_invalid")[0]!.payload as { kind: string };
    expect(inv.kind).toBe("pre_init");
    sock.destroy();
    collector.stop();
  });
});

describe("MODULE-003-AC-08: tool call round-trip + tool_not_registered response", () => {
  test("MODULE-003-T08 — session_init + tool_call with no handler → tool_result with ok:false error:tool_not_registered, same request_id", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "s1" })));
    // Wait for session to be established before sending tool_call.
    await new Promise<void>((res) => setTimeout(res, 100));
    const responsePromise = new Promise<unknown>((resolve) => {
      sock.on("data", (chunk: Buffer) => {
        // Parse length-prefixed frame
        if (chunk.byteLength < 4) return;
        const len = chunk.readUInt32BE(0);
        const body = chunk.subarray(4, 4 + len).toString("utf8");
        try {
          resolve(JSON.parse(body));
        } catch {
          /* ignore */
        }
      });
    });
    sock.write(Buffer.from(encodeFrame({ kind: "tool_call", request_id: "req-42", tool: "reply", params: {} })));
    const resp = (await responsePromise) as { kind: string; request_id: string; ok: boolean; error?: string };
    expect(resp.kind).toBe("tool_result");
    expect(resp.request_id).toBe("req-42");
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("tool_not_registered");
    sock.destroy();
  });
});

describe("MODULE-003-AC-09/AC-10: deliverToSession", () => {
  test("MODULE-003-T09 — deliverToSession writes inbound_push frame to socket", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    let received: unknown = null;
    sock.on("data", (chunk: Buffer) => {
      if (chunk.byteLength < 4) return;
      const len = chunk.readUInt32BE(0);
      const body = chunk.subarray(4, 4 + len).toString("utf8");
      try {
        received = JSON.parse(body);
      } catch {
        /* ignore */
      }
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "s1" })));
    await waitFor(() => collector.byType("session_connected").length > 0, 1000);
    const sessionId = (collector.byType("session_connected")[0]!.payload as { session_id: string }).session_id;
    const result = await acceptor.deliverToSession(sessionId, {
      kind: "inbound_push",
      type: "message",
      payload: { hello: "world" },
    });
    expect(result.ok).toBe(true);
    await waitFor(() => received !== null, 1000);
    expect((received as { kind: string }).kind).toBe("inbound_push");
    sock.destroy();
    collector.stop();
  });

  test("MODULE-003-T10 — deliverToSession with unknown session_id returns error", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const res = await acceptor.deliverToSession("not-a-session-id", {
      kind: "inbound_push",
      type: "message",
      payload: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("unknown_session");
  });
});

describe("MODULE-003-AC-11: disconnectSession", () => {
  test("MODULE-003-T11 — disconnectSession writes disconnect_farewell + closes socket", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    let farewell: unknown = null;
    sock.on("data", (chunk: Buffer) => {
      if (chunk.byteLength < 4) return;
      const len = chunk.readUInt32BE(0);
      try {
        farewell = JSON.parse(chunk.subarray(4, 4 + len).toString("utf8"));
      } catch {
        /* ignore */
      }
    });
    let closed = false;
    sock.on("close", () => {
      closed = true;
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "s1" })));
    await waitFor(() => collector.byType("session_connected").length > 0, 1000);
    const sid = (collector.byType("session_connected")[0]!.payload as { session_id: string }).session_id;
    await acceptor.disconnectSession(sid, "capacity_exceeded");
    await waitFor(() => closed, 2000);
    expect((farewell as { kind: string }).kind).toBe("disconnect_farewell");
    expect((farewell as { reason: string }).reason).toBe("capacity_exceeded");
    collector.stop();
  });
});

describe("MODULE-003-AC-12: session_disconnected on client close", () => {
  test("MODULE-003-T12 — client close → session_disconnected event with reason", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "s1" })));
    await waitFor(() => collector.byType("session_connected").length > 0, 1000);
    sock.destroy();
    await waitFor(() => collector.byType("session_disconnected").length > 0, 2000);
    const dc = collector.byType("session_disconnected")[0]!.payload as { reason: string };
    expect(typeof dc.reason).toBe("string");
    collector.stop();
  });
});

describe("MODULE-003-AC-13: session disconnect triggers cleanup chain (mock subscriber)", () => {
  test("MODULE-003-T13 — session_disconnected fires + subscribers invoked", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    let cleanupCalledForSession: string | null = null;
    tmp.eventBus.on("session_disconnected", (p) => {
      cleanupCalledForSession = p.session_id;
    });
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    const collector = new EventCollector(tmp.eventBus);
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "s1" })));
    await waitFor(() => collector.byType("session_connected").length > 0, 1000);
    sock.destroy();
    await waitFor(() => cleanupCalledForSession !== null, 2000);
    const sid = (collector.byType("session_connected")[0]!.payload as { session_id: string }).session_id;
    expect(cleanupCalledForSession).toBe(sid);
    collector.stop();
  });
});

describe("MODULE-003-AC-02: stale socket cleanup precondition", () => {
  test("MODULE-003-T02 — after M001.cleanupStaleSocket removes a stale socket file, acceptor.start() binds cleanly", async () => {
    const { cleanupStaleSocket } = await import("../../src/daemon/shutdown");
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.socketFile, "");
    // Pre-bind cleanup (simulates M001's helper invoked from main.ts at L11).
    await cleanupStaleSocket(tmp.stateDir.socketFile);
    expect(fs.existsSync(tmp.stateDir.socketFile)).toBe(false);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    expect(fs.existsSync(tmp.stateDir.socketFile)).toBe(true);
  });
});

describe("MODULE-003-AC-16: per-frame read timeout", () => {
  test("MODULE-003-T16 — incomplete frame for >10s emits frame_invalid:timeout", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
      perFrameReadTimeoutMs: 100, // tighten for test
      sessionInitTimeoutMs: 1000,
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();
    const sock = net.connect({ path: tmp.stateDir.socketFile });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "s1" })));
    await waitFor(() => collector.byType("session_connected").length > 0, 1000);
    // Send partial frame (header but no body), then wait.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(100, 0); // declared length 100 bytes
    sock.write(header);
    await waitFor(
      () => collector.byType("frame_invalid").filter((e) => (e.payload as { kind: string }).kind === "timeout").length > 0,
      2000,
    );
    sock.destroy();
    collector.stop();
  });
});

describe("MODULE-003-AC-17: same-uid trust documented in MODULE-003 §1.7", () => {
  test("MODULE-003-T17 — MODULE-003 doc references RISK-012 + same-uid trust boundary", () => {
    const doc = fs.readFileSync(
      "/Users/advance/advance-kit/advance-kit/docs/modules/MODULE-003-mcp-server-proxy.md",
      "utf8",
    );
    expect(doc).toContain("same-uid");
    expect(doc).toContain("RISK-012");
  });
});
