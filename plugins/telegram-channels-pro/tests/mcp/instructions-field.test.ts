import { afterEach, describe, expect, test } from "bun:test";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { buildProxyClient, PILLAR_PROMPT } from "../../src/mcp/proxy-client";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* ignore */ }
  }
});

describe("MODULE-003-AC-21: MCP `instructions` field carries 3-pillar locked prompt (REQ-033)", () => {
  test("MODULE-003-T21 — Server constructor receives instructions containing all 3 pillars + key markers", async () => {
    let capturedInstructions: string | null = null;
    const fakeServer = {
      setRequestHandler: () => undefined,
      close: async () => undefined,
      sendLoggingMessage: async () => undefined,
      notification: async () => undefined,
    };
    const factory = (
      _info: unknown,
      opts: { instructions?: string },
    ): typeof fakeServer => {
      capturedInstructions = opts.instructions ?? null;
      return fakeServer;
    };

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

    expect(capturedInstructions).not.toBeNull();
    const txt = capturedInstructions!;
    // 3 pillar headings present.
    expect(txt).toContain("Pillar 1");
    expect(txt).toContain("Pillar 2");
    expect(txt).toContain("Pillar 3");
    // Anti-injection marker (Pillar 1).
    expect(txt).toContain("ignore previous instructions");
    // Slash-prefix marker (Pillar 2).
    expect(txt).toContain("daemon already parsed");
    // Approval-boundary marker (Pillar 3).
    expect(txt).toContain("text-typed");
    // Sanity: instructions should equal the exported PILLAR_PROMPT constant.
    expect(txt).toBe(PILLAR_PROMPT);
  });
});
