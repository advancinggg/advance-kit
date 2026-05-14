import * as fs from "node:fs";
import * as net from "node:net";
import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";
import {
  encodeFrame,
  FrameDecoder,
  FrameTooLarge,
  MAX_FRAME_BYTES,
} from "./frame";
import {
  isSessionInitFrame,
  isToolCallFrame,
  type DisconnectReason,
  type InboundPushFrame,
  type SessionInitFrame,
  type ToolCallFrame,
  type ToolResultFrame,
} from "./frame-types";
import { SessionMap, type SocketLike } from "./session-map";

export interface MCPAcceptorConfig {
  eventBus: EventBus;
  stateDir: StateDir;
  clock: Clock;
  sessionInitTimeoutMs?: number;
  perFrameReadTimeoutMs?: number;
}

export type ToolHandler = (sessionId: string, frame: ToolCallFrame) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

export class MCPDaemonAcceptor {
  private cfg: Required<MCPAcceptorConfig>;
  private server: net.Server | null = null;
  private sessionMap = new SessionMap();
  private toolHandlers = new Map<string, ToolHandler>();

  constructor(cfg: MCPAcceptorConfig) {
    this.cfg = {
      sessionInitTimeoutMs: 5_000,
      perFrameReadTimeoutMs: 10_000,
      ...cfg,
    };
  }

  registerToolHandler(toolName: string, handler: ToolHandler): void {
    this.toolHandlers.set(toolName, handler);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const socketPath = this.cfg.stateDir.socketFile;
    // Stale-socket cleanup is the caller's responsibility (M001 cleanupStaleSocket).
    const server = net.createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (err) {
      // best-effort; logging via stderr
      process.stderr.write(`mcp-acceptor: chmod 0600 failed for ${socketPath}: ${String(err)}\n`);
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // Disconnect all sessions gracefully.
    for (const entry of Array.from(this.sessionMap.values())) {
      this.closeSession(entry.session_id, "daemon_stop");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleConnection(sock: net.Socket): void {
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    let sessionId: string | null = null;
    let initDone = false;
    let closed = false;
    let initTimer: TimerHandle | null = null;
    let readTimer: TimerHandle | null = null;

    const cleanup = (reason: string): void => {
      if (closed) return;
      closed = true;
      if (initTimer) initTimer.cancel();
      if (readTimer) readTimer.cancel();
      if (sessionId) {
        const entry = this.sessionMap.remove(sessionId);
        if (entry) {
          // Reject any in-flight server-originated tool_call frames.
          for (const { reject } of entry.pending.values()) {
            try {
              reject(new Error("session_terminated"));
            } catch {
              /* ignore */
            }
          }
          this.cfg.eventBus.emit("session_disconnected", {
            session_id: entry.session_id,
            reason,
            uptime_ms: this.cfg.clock.now() - entry.connectedAt,
          });
        }
      }
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    };

    const armReadTimer = (): void => {
      if (readTimer) readTimer.cancel();
      readTimer = this.cfg.clock.setTimeout(() => {
        if (decoder.bytesInBuffer() > 0 && !initDone) {
          this.cfg.eventBus.emit("frame_invalid", {
            session_id: sessionId,
            kind: "timeout",
            detail: "incomplete frame for >10s",
          });
          cleanup("frame_invalid:timeout");
        } else if (decoder.bytesInBuffer() > 0) {
          this.cfg.eventBus.emit("frame_invalid", {
            session_id: sessionId,
            kind: "timeout",
            detail: "incomplete frame for >10s",
          });
          cleanup("frame_invalid:timeout");
        }
      }, this.cfg.perFrameReadTimeoutMs);
    };

    initTimer = this.cfg.clock.setTimeout(() => {
      if (!initDone) {
        this.cfg.eventBus.emit("frame_invalid", {
          session_id: null,
          kind: "pre_init",
          detail: "session_init not received within timeout",
        });
        cleanup("pre_init_timeout");
      }
    }, this.cfg.sessionInitTimeoutMs);

    sock.on("data", (chunk: Buffer) => {
      if (closed) return;
      const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const decoded = decoder.push(u8);
      if (decoded.invalid) {
        this.cfg.eventBus.emit("frame_invalid", {
          session_id: sessionId,
          kind: decoded.invalid.kind,
          detail: decoded.invalid.detail,
        });
        cleanup(`frame_invalid:${decoded.invalid.kind}`);
        return;
      }
      for (const frame of decoded.frames) {
        if (closed) return;
        if (!initDone) {
          if (!isSessionInitFrame(frame)) {
            this.cfg.eventBus.emit("frame_invalid", {
              session_id: sessionId,
              kind: "pre_init",
              detail: `received non-init frame kind=${String((frame as { kind?: unknown }).kind)}`,
            });
            cleanup("pre_init");
            return;
          }
          initDone = true;
          if (initTimer) {
            initTimer.cancel();
            initTimer = null;
          }
          sessionId = this.acceptSession(sock, frame as SessionInitFrame);
        } else {
          if (isToolCallFrame(frame)) {
            void this.dispatchToolCall(sessionId!, frame as ToolCallFrame);
          } else if (
            typeof frame === "object" &&
            frame !== null &&
            (frame as { kind?: unknown }).kind === "tool_result"
          ) {
            // server-originated tool_call's response — resolve pending if matching request_id
            const fr = frame as ToolResultFrame;
            const entry = this.sessionMap.get(sessionId!);
            const pending = entry?.pending.get(fr.request_id);
            if (pending) {
              pending.resolve(fr);
              entry!.pending.delete(fr.request_id);
            }
          } else {
            // Unknown but post-init frame; emit frame_invalid:malformed_json equivalent.
            this.cfg.eventBus.emit("frame_invalid", {
              session_id: sessionId,
              kind: "malformed_json",
              detail: `unknown frame kind=${String((frame as { kind?: unknown }).kind)}`,
            });
            // Don't close — bad frames in steady state are tolerated; keep session open.
          }
        }
      }
      if (decoder.bytesInBuffer() > 0) armReadTimer();
      else if (readTimer) {
        readTimer.cancel();
        readTimer = null;
      }
    });

    sock.on("error", () => {
      cleanup("socket_error");
    });
    sock.on("close", () => {
      cleanup("client_close");
    });
  }

  private acceptSession(sock: net.Socket, init: SessionInitFrame): string {
    const sessionId = this.sessionMap.allocateSessionId();
    const socketLike: SocketLike = {
      write: (data) => sock.write(Buffer.from(data)),
      end: () => sock.end(),
      destroy: () => sock.destroy(),
    };
    this.sessionMap.add({
      session_id: sessionId,
      shortid: init.shortid,
      branch: init.branch,
      socket: socketLike,
      pending: new Map(),
      connectedAt: this.cfg.clock.now(),
    });
    this.cfg.eventBus.emit("session_connected", {
      session_id: sessionId,
      shortid: init.shortid,
      branch: init.branch,
      ts: this.cfg.clock.now(),
    });
    return sessionId;
  }

  private async dispatchToolCall(sessionId: string, frame: ToolCallFrame): Promise<void> {
    this.cfg.eventBus.emit("tool_call", {
      session_id: sessionId,
      request_id: frame.request_id,
      tool: frame.tool,
    });
    const handler = this.toolHandlers.get(frame.tool);
    let result: { ok: boolean; result?: unknown; error?: string };
    if (!handler) {
      result = { ok: false, error: "tool_not_registered" };
    } else {
      try {
        result = await handler(sessionId, frame);
      } catch (err) {
        result = { ok: false, error: String((err as Error)?.message ?? err) };
      }
    }
    this.cfg.eventBus.emit("tool_result", {
      session_id: sessionId,
      request_id: frame.request_id,
      ok: result.ok,
    });
    const resp: ToolResultFrame = {
      kind: "tool_result",
      request_id: frame.request_id,
      ok: result.ok,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    const entry = this.sessionMap.get(sessionId);
    if (!entry) return;
    try {
      const encoded = encodeFrame(resp);
      await entry.socket.write(encoded);
    } catch (err) {
      if (err instanceof FrameTooLarge) {
        process.stderr.write(`mcp-acceptor: tool_result frame too large for session ${sessionId}\n`);
      } else {
        process.stderr.write(`mcp-acceptor: write failed for session ${sessionId}: ${String(err)}\n`);
      }
    }
  }

  async deliverToSession(
    sessionId: string,
    payload: InboundPushFrame,
  ): Promise<{ ok: true } | { ok: false; error: "unknown_session" | "write_failed" }> {
    const entry = this.sessionMap.get(sessionId);
    if (!entry) return { ok: false, error: "unknown_session" };
    try {
      const encoded = encodeFrame(payload);
      await entry.socket.write(encoded);
      return { ok: true };
    } catch {
      return { ok: false, error: "write_failed" };
    }
  }

  async disconnectSession(sessionId: string, reason: DisconnectReason): Promise<void> {
    this.closeSession(sessionId, reason);
  }

  private closeSession(sessionId: string, reason: DisconnectReason | string): void {
    const entry = this.sessionMap.get(sessionId);
    if (!entry) return;
    const isKnownReason: DisconnectReason | null =
      reason === "capacity_exceeded" || reason === "session_terminated" || reason === "daemon_stop" || reason === "admin_rejected"
        ? (reason as DisconnectReason)
        : null;
    if (isKnownReason) {
      try {
        const farewell = encodeFrame({ kind: "disconnect_farewell", reason: isKnownReason });
        void entry.socket.write(farewell);
      } catch {
        /* ignore — proceed to close */
      }
    }
    try {
      entry.socket.end();
    } catch {
      /* ignore */
    }
    this.cfg.clock.setTimeout(() => {
      try {
        entry.socket.destroy();
      } catch {
        /* ignore */
      }
    }, 100);
    // session_disconnected emission happens on the `close` event of the underlying socket.
  }

  /** Test-visible: how many active sessions. */
  sessionCount(): number {
    return this.sessionMap.size();
  }

  /** Test-visible: directly access session entry for assertions. */
  getSessionForTest(sessionId: string): { shortid: string; branch?: string } | undefined {
    const e = this.sessionMap.get(sessionId);
    if (!e) return undefined;
    return { shortid: e.shortid, branch: e.branch };
  }
}
