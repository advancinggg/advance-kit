import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { buildProxyClient } from "../../src/mcp/proxy-client";
import { encodeFrame, FrameDecoder } from "../../src/mcp/frame";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => Promise<void> | void> = [];
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

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("MODULE-003-AC-22: daemon-authoritative shortid (REQ-041)", () => {
  test("MODULE-003-T22a — session_connected.shortid is 12-char hex (daemon-assigned format)", async () => {
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
    cleanups.push(() => { sock.destroy(); });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "proxy-placeholder" })));
    await waitFor(() => collector.byType("session_connected").length > 0);
    const p = collector.byType("session_connected")[0]!.payload as { shortid: string };
    expect(p.shortid).toMatch(/^[0-9a-f]{12}$/);
    // The proxy-supplied placeholder MUST have been overwritten.
    expect(p.shortid).not.toBe("proxy-placeholder");
    collector.stop();
  });

  test("MODULE-003-T22b — two concurrent sessions receive distinct shortids (uniqueness invariant; regen transitive)", async () => {
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

    const sock1 = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { sock1.destroy(); });
    await new Promise<void>((res, rej) => {
      sock1.once("connect", () => res());
      sock1.once("error", rej);
    });
    sock1.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "x" })));
    await waitFor(() => collector.byType("session_connected").length === 1);

    const sock2 = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { sock2.destroy(); });
    await new Promise<void>((res, rej) => {
      sock2.once("connect", () => res());
      sock2.once("error", rej);
    });
    sock2.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "y" })));
    await waitFor(() => collector.byType("session_connected").length === 2);

    const sids = collector
      .byType("session_connected")
      .map((e) => (e.payload as { shortid: string }).shortid);
    expect(sids[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(sids[1]).toMatch(/^[0-9a-f]{12}$/);
    expect(sids[0]).not.toBe(sids[1]);
    collector.stop();
  });

  test("MODULE-003-T22c — session_init_ack frame is delivered (ordering before session_connected verified at the daemon source by code inspection)", async () => {
    // NOTE on ordering: the daemon-acceptor source calls `sock.write(ACK)`
    // BEFORE `eventBus.emit('session_connected', ...)` (see
    // src/mcp/daemon-acceptor.ts acceptSession()). That ordering is a
    // synchronous-call-flow invariant verified by reading the source. From
    // the test process, however, the proxy-side `data` event fires on a
    // microtask after the kernel delivers the bytes — meanwhile the
    // daemon-side `bus.emit` runs synchronously, so the test's
    // `session_connected` subscriber executes BEFORE the proxy's `data`
    // handler in observed order. We therefore assert delivery only and rely
    // on code-inspection for the ordering invariant.
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    cleanups.push(() => collector.stop());
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    cleanups.push(() => acceptor.stop());
    await acceptor.start();

    const sock = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { sock.destroy(); });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });
    const decoder = new FrameDecoder(1_048_576);
    let ackFrameShortid: string | null = null;
    sock.on("data", (chunk: Buffer) => {
      const r = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      for (const frame of r.frames) {
        const f = frame as { kind?: string; shortid?: string };
        if (f.kind === "session_init_ack" && typeof f.shortid === "string") {
          ackFrameShortid = f.shortid;
        }
      }
    });
    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "z" })));

    await waitFor(() => ackFrameShortid !== null);
    await waitFor(() => collector.byType("session_connected").length > 0);

    // The ACK frame's shortid must equal the daemon-assigned shortid that
    // session_connected carries (round-trip consistency — the SAME value
    // the daemon-acceptor source writes is what session_connected emits).
    const eventShortid = (collector.byType("session_connected")[0]!.payload as { shortid: string }).shortid;
    expect(ackFrameShortid).not.toBeNull();
    const ackValue = ackFrameShortid!;
    expect(ackValue).toMatch(/^[0-9a-f]{12}$/);
    expect(ackValue).toBe(eventShortid);
  });

  test("MODULE-003-T22d — buildProxyClient stores daemon-assigned shortid via session_init_ack (ctx.shortid round-trip)", async () => {
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

    const ctx = await buildProxyClient({
      socketPath: tmp.stateDir.socketFile,
      spawnHelper: "/bin/true",
      shortid: "proxy-placeholder",
      branch: "main",
      installSigtermHandler: false,
    });
    cleanups.push(() => ctx.dispose());

    expect(ctx.shortid).not.toBeNull();
    const ctxShortid = ctx.shortid!;
    expect(ctxShortid).toMatch(/^[0-9a-f]{12}$/);

    await waitFor(() => collector.byType("session_connected").length > 0);
    const payloadShortid = (collector.byType("session_connected")[0]!.payload as { shortid: string }).shortid;
    expect(payloadShortid).toBe(ctxShortid);
    collector.stop();
  });

  test("MODULE-003-T22e — buildProxyClient resolves with ctx.shortid===null when ACK is never sent (timeout fallback)", async () => {
    // Spin up a raw net.Server that accepts the connection but NEVER writes
    // back. The proxy's 2s fallback (overridden here to 50ms for test
    // determinism) should fire and resolve buildProxyClient with shortid=null.
    const sockPath = path.join(os.tmpdir(), `tgcp-fake-${randomBytes(4).toString("hex")}.sock`);
    const server = net.createServer((_conn) => {
      /* accept; ignore data; never write ACK */
    });
    await new Promise<void>((res) => server.listen(sockPath, () => res()));
    cleanups.push(
      () =>
        new Promise<void>((res) => {
          server.close(() => res());
        }),
    );

    const ctx = await buildProxyClient({
      socketPath: sockPath,
      spawnHelper: "/bin/true",
      shortid: "proxy-placeholder",
      branch: "main",
      installSigtermHandler: false,
      ackTimeoutMs: 50,
    });
    cleanups.push(() => ctx.dispose());

    expect(ctx.shortid).toBeNull();
  });

  test("MODULE-003-T22f — late session_init_ack after timeout still mutates ctx.shortid on the same reference", async () => {
    // Fake daemon: accept connection, then send the ACK after the proxy's
    // ackTimeoutMs has fired.
    const sockPath = path.join(os.tmpdir(), `tgcp-fake-${randomBytes(4).toString("hex")}.sock`);
    let connSocket: net.Socket | null = null;
    const server = net.createServer((conn) => {
      connSocket = conn;
    });
    await new Promise<void>((res) => server.listen(sockPath, () => res()));
    cleanups.push(
      () =>
        new Promise<void>((res) => {
          server.close(() => res());
        }),
    );

    const ctx = await buildProxyClient({
      socketPath: sockPath,
      spawnHelper: "/bin/true",
      shortid: "proxy-placeholder",
      branch: "main",
      installSigtermHandler: false,
      ackTimeoutMs: 30,
    });
    cleanups.push(() => ctx.dispose());

    // After timeout, ctx.shortid is null.
    expect(ctx.shortid).toBeNull();

    // Now send the late ACK from the fake daemon side.
    expect(connSocket).not.toBeNull();
    const lateAckFrame = encodeFrame({ kind: "session_init_ack", shortid: "abcdef012345" });
    connSocket!.write(Buffer.from(lateAckFrame));

    // The proxy's session_init_ack handler must mutate ctx.shortid on the
    // same reference, even though buildProxyClient already resolved.
    await waitFor(() => ctx.shortid !== null, 1000);
    expect(ctx.shortid).toBe("abcdef012345");
  });
});
