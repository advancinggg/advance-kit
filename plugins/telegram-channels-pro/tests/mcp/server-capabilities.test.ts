import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { buildProxyClient, PROXY_ID } from "../../src/mcp/proxy-client";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* ignore */ }
  }
});

describe("MODULE-003-AC-18: capabilities.experimental['claude/channel'] (REQ-033)", () => {
  test("MODULE-003-T18 — Server constructor receives experimental['claude/channel'] = {} (object, NOT boolean)", async () => {
    let capturedCaps: Record<string, unknown> | null = null;
    let capturedInstructions: string | null = null;
    const fakeServer = {
      setRequestHandler: (_schema: unknown, _handler: unknown) => undefined,
      close: async () => undefined,
      sendLoggingMessage: async (_x: unknown) => undefined,
      notification: async (_n: unknown) => undefined,
    };
    const factory = (
      _info: { name: string; version: string },
      opts: { capabilities: Record<string, unknown>; instructions?: string },
    ): { setRequestHandler: (schema: unknown, handler: unknown) => void; close: () => Promise<void>; sendLoggingMessage: (x: unknown) => Promise<void>; notification: (n: unknown) => Promise<void> } => {
      capturedCaps = opts.capabilities;
      capturedInstructions = opts.instructions ?? null;
      return fakeServer;
    };

    // Spin up a real daemon acceptor so buildProxyClient's socket connect succeeds.
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const acceptor = new MCPDaemonAcceptor({
      eventBus: tmp.eventBus,
      stateDir: tmp.stateDir,
      clock: realClock(),
    });
    await acceptor.start();
    cleanups.push(() => acceptor.stop());

    const ctx = await buildProxyClient({
      socketPath: tmp.stateDir.socketFile,
      shortid: "test1234",
      branch: "main",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverFactory: factory as any,
      installSigtermHandler: false,
    });
    cleanups.push(() => ctx.dispose());

    expect(capturedCaps).not.toBeNull();
    const exp = (capturedCaps as { experimental?: Record<string, unknown> }).experimental;
    expect(exp).toBeDefined();
    // AC-18 — claude/channel must be a JSON OBJECT (SDK Zod requires AssertObjectSchema).
    expect(exp!["claude/channel"]).toEqual({});
    expect(typeof exp!["claude/channel"]).toBe("object");
    expect(exp!["claude/channel"]).not.toBe(true);
    // AC-18 — claude/channel/permission MUST NOT be declared (REQ-009 retained as bespoke tool).
    expect(exp!["claude/channel/permission"]).toBeUndefined();
    // Tools capability remains.
    expect((capturedCaps as { tools?: unknown }).tools).toEqual({});
    expect(capturedInstructions).not.toBeNull();
  });

  test("PROXY_ID is sha256(CLAUDE_PROJECT_PATH).slice(0,16) — 16 hex chars", () => {
    expect(PROXY_ID).toMatch(/^[0-9a-f]{16}$/);
  });
});
