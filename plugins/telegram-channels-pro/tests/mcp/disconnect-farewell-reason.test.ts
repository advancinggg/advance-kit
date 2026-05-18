import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
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

async function setupSession(): Promise<{
  acceptor: MCPDaemonAcceptor;
  sock: net.Socket;
  sessionId: string;
  farewells: Array<{ kind: string; reason?: string }>;
}> {
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
  const farewells: Array<{ kind: string; reason?: string }> = [];
  sock.on("data", (chunk: Buffer) => {
    const r = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    for (const frame of r.frames) {
      const f = frame as { kind?: string; reason?: string };
      if (f.kind === "disconnect_farewell") {
        farewells.push({ kind: f.kind, reason: f.reason });
      }
    }
  });
  sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "placeholder" })));
  await waitFor(() => collector.byType("session_connected").length > 0);
  const sessionId = (collector.byType("session_connected")[0]!.payload as { session_id: string }).session_id;
  return { acceptor, sock, sessionId, farewells };
}

describe("MODULE-003-AC-27: disconnect_farewell carries free-form reason verbatim (REQ-047)", () => {
  test("MODULE-003-T27a — REQ-047 wait-for-reset hint string carried verbatim", async () => {
    const { acceptor, sessionId, farewells } = await setupSession();
    const hint = "registration timed out; run reset-admin to retry";
    await acceptor.disconnectSession(sessionId, hint);
    await waitFor(() => farewells.length > 0);
    expect(farewells[0]!.reason).toBe(hint);
  });

  test("MODULE-003-T27b — discrete DisconnectReason enum value still accepted (backward compatibility)", async () => {
    const { acceptor, sessionId, farewells } = await setupSession();
    await acceptor.disconnectSession(sessionId, "capacity_exceeded");
    await waitFor(() => farewells.length > 0);
    expect(farewells[0]!.reason).toBe("capacity_exceeded");
  });

  test("MODULE-003-T27c — reason longer than 256 chars is truncated to exactly 256 chars (prefix of input)", async () => {
    const { acceptor, sessionId, farewells } = await setupSession();
    const longReason = "x".repeat(300);
    await acceptor.disconnectSession(sessionId, longReason);
    await waitFor(() => farewells.length > 0);
    expect(farewells[0]!.reason).toBeDefined();
    expect(farewells[0]!.reason!.length).toBe(256);
    expect(longReason.startsWith(farewells[0]!.reason!)).toBe(true);
  });
});
