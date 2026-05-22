import type { EventBus } from "../daemon/event-bus";

// REQ-047 stream (c) — wait-for-reset handshake disconnect.
//
// On every `session_connected` event, query M006.isWaitForReset(). If true, immediately
// call M003.disconnectSession(session_id, "registration timed out; run reset-admin to
// retry") to surface the hint to the claude session via M003-AC-27's free-form
// disconnect_farewell channel. Streams (a) stderr periodic + (b) macOS Notification
// Center one-shot are M006-internal per Decision A21 — out of scope for this handler.

export interface RegistrationGateForHandshake {
  isWaitForReset(): boolean;
}

export interface MCPAcceptorForHandshake {
  disconnectSession(session_id: string, reason: string): Promise<void> | void;
}

export interface WaitForResetHandshakeConfig {
  eventBus: EventBus;
  registrationGate: RegistrationGateForHandshake;
  acceptor: MCPAcceptorForHandshake;
}

/**
 * REQ-047 wait-for-reset handshake handler. Must be `install()`d BEFORE
 * `mcpAcceptor.start()` so no session_connected event slips by without subscription.
 * main.ts L14b enforces this boot-order invariant.
 *
 * Idempotency: `disconnecting: Set<string>` guards against a second session_connected
 * for the same session_id while the first disconnect is in flight (event bus fires
 * in registration order; a defensive guard makes the handler safe regardless).
 */
export class WaitForResetHandshakeHandler {
  private disconnecting = new Set<string>();
  private unsub: (() => void) | null = null;

  constructor(private cfg: WaitForResetHandshakeConfig) {}

  install(): () => void {
    this.unsub = this.cfg.eventBus.on("session_connected", (payload) => {
      const p = payload as { session_id: string };
      if (!this.cfg.registrationGate.isWaitForReset()) return;
      if (this.disconnecting.has(p.session_id)) return;
      this.disconnecting.add(p.session_id);
      // EventBus is synchronous; we don't await async subscribers. Fire-and-forget the
      // disconnect (mcpAcceptor.disconnectSession is idempotent on sessionMap.get).
      Promise.resolve(
        this.cfg.acceptor.disconnectSession(
          p.session_id,
          "registration timed out; run reset-admin to retry",
        ),
      ).finally(() => this.disconnecting.delete(p.session_id));
    });
    return () => this.dispose();
  }

  dispose(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }
}
