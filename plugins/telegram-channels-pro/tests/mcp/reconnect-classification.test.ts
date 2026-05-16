import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { encodeFrame } from "../../src/mcp/frame";
import type { StateDir } from "../../src/daemon/state-dir";
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

// Build a StateDir wrapper that overrides getPostBootShutdownContext.
function makeStateDirWithContext(
  base: StateDir,
  ctx: "sigterm" | "keepalive" | "none",
): StateDir {
  let consumed = false;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "getPostBootShutdownContext") {
        return () => {
          if (consumed) return "none" as const;
          consumed = true;
          return ctx;
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (target as any)[prop];
    },
  });
}

async function setupAndConnect(
  ctx: "sigterm" | "keepalive" | "none",
): Promise<{
  acceptor: MCPDaemonAcceptor;
  bus: ReturnType<typeof makeTmpStateDir>["eventBus"];
  socketPath: string;
}> {
  const tmp = makeTmpStateDir();
  cleanups.push(tmp.cleanup);
  await tmp.stateDir.initialize();
  const wrappedStateDir = makeStateDirWithContext(tmp.stateDir, ctx);
  const acceptor = new MCPDaemonAcceptor({
    eventBus: tmp.eventBus,
    stateDir: wrappedStateDir,
    clock: realClock(),
    sessionInitTimeoutMs: 60_000,
  });
  await acceptor.start();
  cleanups.push(() => acceptor.stop());
  return { acceptor, bus: tmp.eventBus, socketPath: tmp.stateDir.socketFile };
}

async function connectAndSendInit(
  socketPath: string,
  shortid: string,
  proxyId?: string,
): Promise<net.Socket> {
  const sock = net.connect({ path: socketPath });
  cleanups.push(() => { try { sock.destroy(); } catch { /* ignore */ } });
  await new Promise<void>((res, rej) => {
    sock.once("connect", () => res());
    sock.once("error", rej);
  });
  sock.write(
    Buffer.from(
      encodeFrame({
        kind: "session_init",
        shortid,
        branch: "main",
        ...(proxyId !== undefined ? { proxy_id: proxyId } : {}),
      }),
    ),
  );
  return sock;
}

describe("MODULE-003-AC-24: spurious reconnect classification (REQ-045)", () => {
  test("MODULE-003-T24 — session_init with no prior will_reconnect AND ctx='none' → spurious", async () => {
    const { bus, socketPath } = await setupAndConnect("none");
    const events: Array<{ classification: string; reason: string }> = [];
    const unsub = bus.on("mcp_reconnect_classified", (p) => events.push({ classification: p.classification, reason: p.reason }));
    cleanups.push(() => unsub());

    await connectAndSendInit(socketPath, "test1234");
    await waitFor(() => events.length === 1);

    expect(events[0]).toEqual({ classification: "spurious", reason: "spurious" });
  });
});

describe("MODULE-003-AC-24b: sigterm reconnect classification (REQ-045)", () => {
  test("MODULE-003-T24b — first session_init after ctx='sigterm' → sigterm; subsequent → spurious (one-shot)", async () => {
    const { bus, socketPath } = await setupAndConnect("sigterm");
    const events: Array<{ classification: string; reason: string }> = [];
    const unsub = bus.on("mcp_reconnect_classified", (p) => events.push({ classification: p.classification, reason: p.reason }));
    cleanups.push(() => unsub());

    // First reconnect — wins sigterm label.
    await connectAndSendInit(socketPath, "first1234");
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ classification: "scripted", reason: "sigterm" });

    // Second reconnect within same daemon instance — one-shot consumed, falls back to 'none' → spurious.
    await connectAndSendInit(socketPath, "second12");
    await waitFor(() => events.length === 2);
    expect(events[1]).toEqual({ classification: "spurious", reason: "spurious" });
  });
});

describe("MODULE-003-AC-24c: keepalive reconnect classification (REQ-045)", () => {
  test("MODULE-003-T24c — first session_init after ctx='keepalive' → keepalive; subsequent → spurious (one-shot)", async () => {
    const { bus, socketPath } = await setupAndConnect("keepalive");
    const events: Array<{ classification: string; reason: string }> = [];
    const unsub = bus.on("mcp_reconnect_classified", (p) => events.push({ classification: p.classification, reason: p.reason }));
    cleanups.push(() => unsub());

    await connectAndSendInit(socketPath, "first1234");
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ classification: "scripted", reason: "keepalive" });

    await connectAndSendInit(socketPath, "second12");
    await waitFor(() => events.length === 2);
    expect(events[1]).toEqual({ classification: "spurious", reason: "spurious" });
  });
});

describe("MODULE-003-AC-24/24b/24c: emission order — mcp_reconnect_classified BEFORE session_connected", () => {
  test("Sequence: allocate session_id → emit mcp_reconnect_classified → register → emit session_connected", async () => {
    const { bus, socketPath } = await setupAndConnect("none");
    const eventSequence: string[] = [];
    const u1 = bus.on("mcp_reconnect_classified", () => eventSequence.push("classified"));
    const u2 = bus.on("session_connected", () => eventSequence.push("connected"));
    cleanups.push(() => { u1(); u2(); });

    await connectAndSendInit(socketPath, "test1234");
    await waitFor(() => eventSequence.length === 2);

    expect(eventSequence).toEqual(["classified", "connected"]);
  });
});

describe("MODULE-003-AC-24/24b/24c: getPostBootShutdownContext source-contract", () => {
  test("acceptSession reads getPostBootShutdownContext when no prior will_reconnect entry", () => {
    const src = fs.readFileSync(
      `${import.meta.dir}/../../src/mcp/daemon-acceptor.ts`,
      "utf8",
    );
    expect(src).toContain("this.cfg.stateDir.getPostBootShutdownContext()");
    expect(src).toContain('reason = "sigterm"');
    expect(src).toContain('reason = "keepalive"');
    expect(src).toContain('reason = "spurious"');
    expect(src).toContain('reason = "reload_handshake"');
  });
});
