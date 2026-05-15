import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { realClock } from "../../src/daemon/clock";
import { MCPDaemonAcceptor } from "../../src/mcp/daemon-acceptor";
import { encodeFrame, FrameDecoder } from "../../src/mcp/frame";
import { buildProxyClient } from "../../src/mcp/proxy-client";
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
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("MODULE-003-AC-14: claude-side proxy uses MCP SDK; registers 5 tool handlers", () => {
  test("MODULE-003-T14 — buildProxyClient connects to daemon UDS, sends session_init, registers 5 tools (verified via ListTools handler)", async () => {
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
    const collector = new EventCollector(tmp.eventBus);
    cleanups.push(() => collector.stop());

    // Fake spawn helper (won't be invoked since the real socket exists)
    const fakeSpawn = "/bin/true";

    const ctx = await buildProxyClient({
      socketPath: tmp.stateDir.socketFile,
      spawnHelper: fakeSpawn,
      shortid: "abcd1234",
      branch: "main",
    });
    cleanups.push(() => ctx.dispose());

    // Wait for the daemon side to register the session
    await waitFor(() => collector.byType("session_connected").length > 0, 2000);
    const evts = collector.byType("session_connected");
    expect(evts.length).toBe(1);
    const payload = evts[0]!.payload as { session_id: string; shortid: string; branch?: string };
    expect(payload.shortid).toBe("abcd1234");
    expect(payload.branch).toBe("main");

    // Verify the 5 tool handlers are registered on the SDK Server (call ListTools internally)
    // The SDK exposes setRequestHandler; we verify the handler returns 5 tools by simulating a request
    // Since the Server isn't connected to a transport yet, we read TOOL_DEFS via the server's
    // internal handler — but the cleanest check is via the response shape of the buildProxyClient
    // function: server is exposed in ctx, so we can interrogate.
    const toolListResp = await (ctx.server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<{ tools: Array<{ name: string }> }>>;
    })._requestHandlers.get("tools/list")!({ params: {}, method: "tools/list" });
    expect(toolListResp.tools.length).toBe(5);
    const names = toolListResp.tools.map((t) => t.name).sort();
    expect(names).toEqual(["download_attachment", "edit_message", "react", "reply", "request_approval"]);
  });
});

describe("MODULE-003-AC-15: /reload-plugins → proxy restart → daemon emits session_disconnected then session_connected", () => {
  test("MODULE-003-T15 — proxy disconnect emits session_disconnected; reconnect emits session_connected with NEW session_id", async () => {
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
    const collector = new EventCollector(tmp.eventBus);
    cleanups.push(() => collector.stop());

    const fakeSpawn = "/bin/true";

    // First proxy connect (simulates initial claude session)
    const ctx1 = await buildProxyClient({
      socketPath: tmp.stateDir.socketFile,
      spawnHelper: fakeSpawn,
      shortid: "session1",
      branch: "main",
    });
    await waitFor(() => collector.byType("session_connected").length === 1, 2000);
    const firstSessionId = (collector.byType("session_connected")[0]!.payload as { session_id: string }).session_id;

    // Simulate /reload-plugins by closing the proxy
    await ctx1.dispose();
    // Note: ctx1.dispose may schedule process.exit(1) via setTimeout; for the test
    // we rely only on the socket close + session_disconnected event.
    await waitFor(() => collector.byType("session_disconnected").length === 1, 2000);

    // Second proxy connect (simulates new claude session after /reload-plugins)
    const ctx2 = await buildProxyClient({
      socketPath: tmp.stateDir.socketFile,
      spawnHelper: fakeSpawn,
      shortid: "session2",
      branch: "main",
    });
    cleanups.push(() => ctx2.dispose());
    await waitFor(() => collector.byType("session_connected").length === 2, 2000);
    const secondSessionId = (collector.byType("session_connected")[1]!.payload as { session_id: string }).session_id;

    // Daemon-assigned session_id MUST differ between connects
    expect(secondSessionId).not.toBe(firstSessionId);
    // Verify shortid difference too
    expect((collector.byType("session_connected")[0]!.payload as { shortid: string }).shortid).toBe("session1");
    expect((collector.byType("session_connected")[1]!.payload as { shortid: string }).shortid).toBe("session2");
  });
});

describe("Proxy-client tool dispatch round-trip (smoke)", () => {
  test("tool_call → daemon handler → tool_result round-trip via real UDS", async () => {
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
    // Register a stub handler for `reply` that echoes back
    acceptor.registerToolHandler("reply", async (sessionId, frame) => {
      return { ok: true, result: { delivered: true, message_id: 99, echo: frame.params } };
    });

    const fakeSpawn = "/bin/true";
    const ctx = await buildProxyClient({
      socketPath: tmp.stateDir.socketFile,
      spawnHelper: fakeSpawn,
      shortid: "round1",
      branch: "main",
    });
    cleanups.push(() => ctx.dispose());

    // Drive the SDK CallTool path manually (the SDK isn't connected to stdio in tests)
    const callToolHandler = (ctx.server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    })._requestHandlers.get("tools/call")!;
    const result = await callToolHandler({
      method: "tools/call",
      params: { name: "reply", arguments: { chat_id: 1, text: "hi" } },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.delivered).toBe(true);
    expect(parsed.result.message_id).toBe(99);
  });
});

// Helper to verify ListTools handler is reachable via the SDK's internal map.
// We don't import frame directly here since it's used only through the buildProxyClient flow.
void encodeFrame;
void FrameDecoder;
void net;
void fs;
