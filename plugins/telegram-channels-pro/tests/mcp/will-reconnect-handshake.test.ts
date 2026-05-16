import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { fakeClock, realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { encodeFrame, FrameDecoder } from "../../src/mcp/frame";
import { isWillReconnectFrame, type SessionInitFrame, type WillReconnectFrame } from "../../src/mcp/frame-types";
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

describe("MODULE-003-AC-23: tgcp/proxy/will_reconnect handshake (REQ-045 + Decision A22)", () => {
  test("MODULE-003-T23a — proxy-side wire format: PROXY_ID = sha256(CLAUDE_PROJECT_PATH).slice(0,16) + SIGTERM handler emits will_reconnect frame", async () => {
    // PROXY_ID formula verification.
    const expectedProxyId = createHash("sha256")
      .update(process.env.CLAUDE_PROJECT_PATH ?? "")
      .digest("hex")
      .slice(0, 16);
    const { PROXY_ID } = await import("../../src/mcp/proxy-client");
    expect(PROXY_ID).toBe(expectedProxyId);
    expect(PROXY_ID).toMatch(/^[0-9a-f]{16}$/);

    // Source-contract: proxy-client.ts SIGTERM handler emits WillReconnectFrame with proxy_id + reason.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/mcp/proxy-client.ts"), "utf8");
    expect(src).toContain('process.on("SIGTERM", onSigterm)');
    expect(src).toContain('kind: "will_reconnect"');
    expect(src).toContain('reason: "reload_plugins"');
    expect(src).toContain("proxy_id: PROXY_ID");
  });

  test("MODULE-003-T23b — daemon records proxy_id → scripted_until_ts ≈ now+60s on WillReconnectFrame receipt", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const clock = realClock();
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock,
      sessionInitTimeoutMs: 60_000,
    });
    await acceptor.start();
    cleanups.push(() => acceptor.stop());

    const sock = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { try { sock.destroy(); } catch { /* ignore */ } });
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });

    sock.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "test1234", branch: "main" })));
    await waitFor(() => acceptor.sessionCount() === 1);

    const tBefore = clock.now();
    sock.write(Buffer.from(encodeFrame({ kind: "will_reconnect", proxy_id: "abc1234567890def", reason: "reload_plugins" })));
    await waitFor(() => acceptor.scriptedReconnectMapSizeForTest() === 1);
    const tAfter = clock.now();

    const entry = acceptor.scriptedReconnectEntryForTest("abc1234567890def");
    expect(entry).toBeDefined();
    // expiryMs is ≈ now()+60_000 captured at receipt time; allow loose bounds for the wait.
    expect(entry!.expiryMs).toBeGreaterThanOrEqual(tBefore + 60_000);
    expect(entry!.expiryMs).toBeLessThanOrEqual(tAfter + 60_000 + 100);
  });

  test("MODULE-003-T23c — subsequent session_init from matching proxy_id → mcp_reconnect_classified reload_handshake; entry consumed", async () => {
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

    // First connection: session_init + will_reconnect.
    const sock1 = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { try { sock1.destroy(); } catch { /* ignore */ } });
    await new Promise<void>((res, rej) => { sock1.once("connect", () => res()); sock1.once("error", rej); });
    sock1.write(Buffer.from(encodeFrame({ kind: "session_init", shortid: "first1234", branch: "main" })));
    await waitFor(() => acceptor.sessionCount() === 1);
    sock1.write(Buffer.from(encodeFrame({ kind: "will_reconnect", proxy_id: "abc1234567890def", reason: "reload_plugins" })));
    await waitFor(() => acceptor.scriptedReconnectMapSizeForTest() === 1);
    sock1.destroy();
    await waitFor(() => acceptor.sessionCount() === 0);

    // Track mcp_reconnect_classified events.
    const events: Array<{ classification: string; reason: string }> = [];
    const unsub = tmp.eventBus.on("mcp_reconnect_classified", (payload) => {
      events.push({ classification: payload.classification, reason: payload.reason });
    });
    cleanups.push(() => unsub());

    // Second connection with matching proxy_id within window.
    const sock2 = net.connect({ path: tmp.stateDir.socketFile });
    cleanups.push(() => { try { sock2.destroy(); } catch { /* ignore */ } });
    await new Promise<void>((res, rej) => { sock2.once("connect", () => res()); sock2.once("error", rej); });
    sock2.write(
      Buffer.from(
        encodeFrame({
          kind: "session_init",
          shortid: "second12",
          branch: "main",
          proxy_id: "abc1234567890def",
        }),
      ),
    );
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ classification: "scripted", reason: "reload_handshake" });
    expect(acceptor.scriptedReconnectMapSizeForTest()).toBe(0);
  });

  test("MODULE-003-T23d — scriptedReconnectMap entry expires silently after 60s without reconnect (no event emitted)", async () => {
    // Source-contract verification: the recordWillReconnect private method schedules a
    // 60_000ms setTimeout whose callback only deletes the map entry — no event emit.
    // (This complements the live behavior verified by T23b/T23c by guarding the expiry path.)
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/mcp/daemon-acceptor.ts"), "utf8");

    // Locate the recordWillReconnect FUNCTION DEFINITION (`private recordWillReconnect`),
    // not the call site, and isolate its body up to the closing brace at top-level.
    const defAnchor = "private recordWillReconnect(proxyId: string): void {";
    const idx = src.indexOf(defAnchor);
    expect(idx).toBeGreaterThan(-1);
    // Take a generous slice forward of the anchor; the next `private` or `}` block-end
    // bounds the function body.
    const after = src.slice(idx);
    const nextPrivate = after.indexOf("\n  private ", defAnchor.length);
    const body = nextPrivate >= 0 ? after.slice(0, nextPrivate) : after.slice(0, 2000);

    // Body must schedule a setTimeout with 60_000ms expiry.
    expect(body).toContain("setTimeout(");
    expect(body).toContain("60_000");
    // The expiry callback must delete the entry (silent cleanup).
    expect(body).toContain("this.scriptedReconnectMap.delete(proxyId)");
    // The expiry callback must NOT emit any event.
    expect(body).not.toMatch(/setTimeout\([^)]*eventBus\.emit/);
    expect(body).not.toContain("emit(\"mcp_reconnect_classified\"");
  });
});
