import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { Unsubscribe } from "../daemon/event-types";
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
  isWillReconnectFrame,
  type ChannelNotificationFrame,
  type DisconnectReason,
  type InboundPushFrame,
  type QuarantineReplyResolvedNotificationFrame,
  type QuarantineStateChangedFrame,
  type SessionInitFrame,
  type ToolCallFrame,
  type ToolResultFrame,
  type WillReconnectFrame,
} from "./frame-types";
import { SessionMap, type SocketLike } from "./session-map";
import { redactString } from "../obs/redaction";

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
  // REQ-045 AC-23 — proxy_id → {expiryMs, timer}; entries set on will_reconnect receipt,
  // consumed on next session_init from same proxy_id within 60s, deleted on expiry.
  private scriptedReconnectMap = new Map<string, { expiryMs: number; timer: TimerHandle }>();
  // REQ-045 AC-25/AC-26 — EventBus subscription handles, registered in start(), released in stop().
  private quarantineSubs: Unsubscribe[] = [];

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
    // REQ-045 AC-25/AC-26 — subscribe to quarantine-related M002 events for MCP notification forwarding.
    this.quarantineSubs.push(
      this.cfg.eventBus.on("quarantine_replay_resolved", (payload) => this.onQuarantineReplayResolved(payload)),
      this.cfg.eventBus.on("quarantine_enter", (payload) => this.onQuarantineStateChange("quarantine_enter", payload)),
      this.cfg.eventBus.on("quarantine_exit", (payload) => this.onQuarantineStateChange("quarantine_exit", payload)),
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // Unregister EventBus subscriptions.
    for (const unsub of this.quarantineSubs) unsub();
    this.quarantineSubs = [];
    // Clear scriptedReconnectMap timers to prevent leaks.
    for (const v of this.scriptedReconnectMap.values()) v.timer.cancel();
    this.scriptedReconnectMap.clear();
    // Disconnect all sessions gracefully.
    for (const entry of Array.from(this.sessionMap.values())) {
      this.closeSession(entry.session_id, "daemon_stop");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * REQ-033 AC-19/20/28 — deliver a channel notification to a named session.
   * - Unknown session_id → emit log_emit ERROR (no throw, no socket write).
   * - Found → encode ChannelNotificationFrame, write to socket, emit channel_notification_emitted event.
   */
  async deliverChannelNotification(
    sessionId: string,
    payload: { text: string; image_path?: string; attachment_file_id?: string },
    meta: { chat_id: number; message_id: number; user: string; ts: number },
  ): Promise<{ ok: true } | { ok: false; error: "unknown_session" | "write_failed" }> {
    const entry = this.sessionMap.get(sessionId);
    if (!entry) {
      this.cfg.eventBus.emit("log_emit", {
        level: "ERROR",
        event_type: "unknown_session_in_deliverChannelNotification",
        fields: {
          session_id: sessionId,
          chat_id: meta.chat_id,
          message_id: meta.message_id,
        },
      });
      return { ok: false, error: "unknown_session" };
    }
    const frame: ChannelNotificationFrame = {
      kind: "channel_notification",
      text: payload.text,
      ...(payload.image_path !== undefined ? { image_path: payload.image_path } : {}),
      ...(payload.attachment_file_id !== undefined ? { attachment_file_id: payload.attachment_file_id } : {}),
      chat_id: meta.chat_id,
      message_id: meta.message_id,
      user: meta.user,
      ts: meta.ts,
    };
    try {
      const encoded = encodeFrame(frame);
      await entry.socket.write(encoded);
      this.cfg.eventBus.emit("channel_notification_emitted", {
        session_id: sessionId,
        chat_id: meta.chat_id,
        message_id: meta.message_id,
      });
      return { ok: true };
    } catch {
      return { ok: false, error: "write_failed" };
    }
  }

  // REQ-045 AC-25 — translate quarantine_replay_resolved EventBus event into a UDS frame
  // to the originating requester_session's MCP transport. Drop silently if session gone.
  private onQuarantineReplayResolved(payload: {
    requester_session: string;
    message_id?: number;
    delivered: boolean;
    queued_at: number;
    replayed_at: number;
    error_class?: string;
  }): void {
    const entry = this.sessionMap.get(payload.requester_session);
    if (!entry) return;
    const frame: QuarantineReplyResolvedNotificationFrame = {
      kind: "quarantine_reply_resolved",
      requester_session: payload.requester_session,
      ...(payload.message_id !== undefined ? { message_id: payload.message_id } : {}),
      delivered: payload.delivered,
      queued_at: payload.queued_at,
      replayed_at: payload.replayed_at,
      ...(payload.error_class !== undefined ? { error_class: payload.error_class } : {}),
    };
    try {
      const encoded = encodeFrame(frame);
      void entry.socket.write(encoded);
    } catch {
      /* best-effort */
    }
  }

  // REQ-045 AC-26 — translate quarantine_enter/exit EventBus event into UDS frames to
  // ALL active session sockets (broadcast). eta_hint forwarded verbatim (default 0 if absent).
  private onQuarantineStateChange(
    state: "quarantine_enter" | "quarantine_exit",
    payload: { eta_hint?: number },
  ): void {
    const eta_hint = payload.eta_hint ?? 0;
    const frame: QuarantineStateChangedFrame = {
      kind: "quarantine_state_changed",
      state,
      eta_hint,
    };
    let encoded: Uint8Array;
    try {
      encoded = encodeFrame(frame);
    } catch {
      return;
    }
    for (const entry of Array.from(this.sessionMap.values())) {
      try {
        void entry.socket.write(encoded);
      } catch {
        /* best-effort per-session */
      }
    }
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
          } else if (isWillReconnectFrame(frame)) {
            // REQ-045 AC-23 — claude-side proxy is about to disconnect on /reload-plugins.
            // Record proxy_id with 60s expiry; next session_init from same proxy_id
            // within window classifies as 'reload_handshake' (scripted).
            this.recordWillReconnect((frame as WillReconnectFrame).proxy_id);
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

    // REQ-045 AC-24/24b/24c — classify reconnect BEFORE emitting session_connected
    // so subscribers receive classification + connection in the documented order.
    let classification: "scripted" | "spurious";
    let reason: "reload_handshake" | "sigterm" | "keepalive" | "spurious";
    const scripted = init.proxy_id ? this.scriptedReconnectMap.get(init.proxy_id) : undefined;
    if (scripted && scripted.expiryMs > this.cfg.clock.now()) {
      classification = "scripted";
      reason = "reload_handshake";
      scripted.timer.cancel(); // race-safe — entry is being consumed before expiry fires
      this.scriptedReconnectMap.delete(init.proxy_id!);
    } else {
      const ctx = this.cfg.stateDir.getPostBootShutdownContext();
      if (ctx === "sigterm") {
        classification = "scripted";
        reason = "sigterm";
      } else if (ctx === "keepalive") {
        classification = "scripted";
        reason = "keepalive";
      } else {
        classification = "spurious";
        reason = "spurious";
      }
    }
    this.cfg.eventBus.emit("mcp_reconnect_classified", {
      session_id: sessionId,
      classification,
      reason,
    });

    // REQ-041 — daemon is the sole shortid authority. Allocate a 12-char hex
    // shortid unique within the active session set; the proxy-supplied
    // init.shortid is a placeholder and is overwritten here. Write the
    // session_init_ack frame to the socket BEFORE emitting session_connected
    // so the proxy can resolve buildProxyClient with the authoritative value
    // before any downstream observer sees the session.
    let assignedShortid: string;
    try {
      assignedShortid = this.assignUniqueShortid();
    } catch (err) {
      // Astronomically unlikely — `assignUniqueShortid` only throws after
      // 1024 consecutive randomBytes collisions (suspect RNG / malicious
      // mock). Refuse this session gracefully instead of letting the throw
      // escape the `sock.on("data")` callback as an uncaughtException that
      // kills the daemon. Existing sessions stay intact.
      this.cfg.eventBus.emit("log_emit", {
        level: "ERROR",
        event_type: "shortid_allocation_failed",
        fields: { detail: String(err) },
      });
      try {
        sock.end();
      } catch {
        /* ignore */
      }
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      return sessionId;
    }

    const socketLike: SocketLike = {
      write: (data) => sock.write(Buffer.from(data)),
      end: () => sock.end(),
      destroy: () => sock.destroy(),
    };
    try {
      sock.write(Buffer.from(encodeFrame({ kind: "session_init_ack", shortid: assignedShortid })));
    } catch {
      /* ignore write errors — proxy may have already disconnected; session_connected
         emission still proceeds (sessionMap update happens regardless). */
    }
    this.sessionMap.add({
      session_id: sessionId,
      shortid: assignedShortid,
      branch: init.branch,
      socket: socketLike,
      pending: new Map(),
      connectedAt: this.cfg.clock.now(),
    });
    this.cfg.eventBus.emit("session_connected", {
      session_id: sessionId,
      shortid: assignedShortid,
      branch: init.branch,
      ts: this.cfg.clock.now(),
    });
    return sessionId;
  }

  // REQ-041 — daemon-internal shortid allocator. NOT on the public CONTRACT-006
  // MCPTransport surface (relocated from the v1.1.0 public-interface
  // declaration to a private helper — see MODULE-003 §3.8). 12-char hex via
  // crypto.randomBytes(6); regenerated on collision with any shortid currently
  // present in the active session set. Released implicitly when the session-
  // map entry is removed on disconnect.
  private assignUniqueShortid(): string {
    // Bounded by the active session set size (max 8 per REQ-022), so a
    // 12-char hex collision is astronomically unlikely; the loop is a
    // correctness guarantee, not a performance concern.
    // Cap iterations at a large constant to avoid an infinite loop on a
    // misbehaving RNG mock; in practice this never triggers.
    for (let i = 0; i < 1024; i++) {
      const candidate = randomBytes(6).toString("hex");
      let inUse = false;
      for (const entry of this.sessionMap.values()) {
        if (entry.shortid === candidate) {
          inUse = true;
          break;
        }
      }
      if (!inUse) return candidate;
    }
    throw new Error("assignUniqueShortid: exhausted collision-regen attempts (suspect RNG)");
  }

  // REQ-045 AC-23 — record a proxy_id → expiry mapping; auto-delete on timer fire.
  // Hard upper bound on the scriptedReconnectMap size — defends against
  // a same-uid rogue process that sends a sustained rate of valid
  // `will_reconnect` frames with distinct proxy_ids (each frame consumes
  // a 60s-timer entry; without a cap the map grows unbounded). 256 is
  // comfortably above the 24 entries a busy 8-session × 3-reloads-per-min
  // pattern would generate within the 60s expiry window. When full, the
  // OLDEST entry (by insertion order, which is `Map`'s iteration order)
  // is evicted FIFO-style: its timer is cancelled and the entry removed.
  private static readonly SCRIPTED_RECONNECT_MAX_ENTRIES = 256;

  private recordWillReconnect(proxyId: string): void {
    // If a prior entry exists, cancel its timer first to avoid orphans.
    const prior = this.scriptedReconnectMap.get(proxyId);
    if (prior) prior.timer.cancel();
    // FIFO evict the oldest entry when at the cap (entries always insert at
    // the end; oldest is the first iteration key). The prior entry above is
    // already deleted (will be re-inserted as the newest below), so the
    // cap check runs against entries we are NOT about to overwrite.
    while (this.scriptedReconnectMap.size >= MCPDaemonAcceptor.SCRIPTED_RECONNECT_MAX_ENTRIES) {
      const oldestKey = this.scriptedReconnectMap.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.scriptedReconnectMap.get(oldestKey);
      if (oldest) oldest.timer.cancel();
      this.scriptedReconnectMap.delete(oldestKey);
    }
    const expiryMs = this.cfg.clock.now() + 60_000;
    const timer = this.cfg.clock.setTimeout(() => {
      // Silent expiry; no event emitted.
      this.scriptedReconnectMap.delete(proxyId);
    }, 60_000);
    this.scriptedReconnectMap.set(proxyId, { expiryMs, timer });
  }

  /** Test-visible: inspect scriptedReconnectMap state. */
  scriptedReconnectMapSizeForTest(): number {
    return this.scriptedReconnectMap.size;
  }

  /** Test-visible: get an entry from scriptedReconnectMap. */
  scriptedReconnectEntryForTest(proxyId: string): { expiryMs: number } | undefined {
    const e = this.scriptedReconnectMap.get(proxyId);
    if (!e) return undefined;
    return { expiryMs: e.expiryMs };
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

  // v1.1.0 — reason widened to accept the discrete DisconnectReason enum OR a
  // free-form string (REQ-047 wait-for-reset hint). Strict superset; all
  // existing enum callers still type-check.
  async disconnectSession(sessionId: string, reason: DisconnectReason | string): Promise<void> {
    this.closeSession(sessionId, reason);
  }

  private closeSession(sessionId: string, reason: DisconnectReason | string): void {
    const entry = this.sessionMap.get(sessionId);
    if (!entry) return;
    // v1.1.0 (REQ-047) — write the farewell frame for ANY reason value. The
    // prior `isKnownReason` allowlist gate silently dropped free-form reasons
    // (a latent bug) and has been removed. Defense-in-depth layering:
    // 1) `redactString` strips bot tokens + registration codes inline (in
    //    case a future caller accidentally plumbs sensitive data through
    //    the now-widened reason field — the type signature
    //    `DisconnectReason | string` invites that misuse);
    // 2) 256-char truncation cap (same pattern as will_reconnect.proxy_id).
    const safeReason = redactString(String(reason)).slice(0, 256);
    try {
      const farewell = encodeFrame({ kind: "disconnect_farewell", reason: safeReason });
      void entry.socket.write(farewell);
    } catch {
      /* ignore — proceed to close */
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
