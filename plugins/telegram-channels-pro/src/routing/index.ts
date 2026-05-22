import type { TelegramAPIClient } from "../telegram/client";
import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { MCPDaemonAcceptor } from "../mcp/daemon-acceptor";
import type { AdminAllowlist } from "../auth/allowlist";
import type { RegistrationGate } from "../auth/registration-gate";
import type { StatusReporter } from "../obs/status-reporter";
import type { PendingApprovalRegistry } from "../tools/pending-registry";
import type { ChatTypeCache } from "../telegram/chat-type-cache";
import { SessionRegistry } from "./session-registry";
import { AdminChatRegistry } from "./admin-chat-registry";
import { NoSessionReplyThrottle } from "./no-session-throttle";
import { InboundDispatcher } from "./inbound-dispatcher";
import { WaitForResetHandshakeHandler } from "./wait-for-reset-handshake";

export interface InstallRoutingArgs {
  acceptor: MCPDaemonAcceptor;
  tg: TelegramAPIClient;
  eventBus: EventBus;
  clock: Clock;
  adminAllowlist: AdminAllowlist;
  registrationGate: RegistrationGate;
  statusReporter: StatusReporter;
  pendingRegistry: PendingApprovalRegistry;
  /** Pre-constructed AdminChatRegistry (with env already parsed at L8a per CCD-20). */
  adminChatRegistry: AdminChatRegistry;
  // v1.1.0 — REQ-035 outbound chat-type DiD (M005-AC-22 primeCache + tools consume).
  chatTypeCache: ChatTypeCache;
  /**
   * v1.1.0 — REQ-047 stream (c) wait-for-reset handshake handler. OPTIONAL: when passed,
   * routing uses the already-installed handler (main.ts L14b boot-order invariant — handler
   * installed BEFORE mcpAcceptor.start() to close boot-race). When absent (test scenarios),
   * routing constructs and installs its own.
   */
  waitForResetHandshake?: WaitForResetHandshakeHandler;
  noSessionIntervalMs?: number;
  sessionCapacity?: number;
}

export interface RoutingCtx {
  dispose(): void;
  getSessionRegistry(): SessionRegistry;
  getThrottle(): NoSessionReplyThrottle;
}

export function installRouting(args: InstallRoutingArgs): RoutingCtx {
  // v1.1.0 — REQ-047 wait-for-reset handshake. When passed in (main.ts L14b path),
  // use the already-installed instance to preserve the boot-race-safe registration order
  // (handshake subscribed BEFORE mcpAcceptor.start()). When absent (test scenarios),
  // construct + install here.
  let waitForResetHandshake = args.waitForResetHandshake;
  let waitForResetDispose: (() => void) | null = null;
  if (waitForResetHandshake === undefined) {
    waitForResetHandshake = new WaitForResetHandshakeHandler({
      eventBus: args.eventBus,
      registrationGate: args.registrationGate,
      acceptor: args.acceptor,
    });
    waitForResetDispose = waitForResetHandshake.install();
  }

  const sessionRegistry = new SessionRegistry({
    eventBus: args.eventBus,
    clock: args.clock,
    capacity: args.sessionCapacity,
    disconnectSession: (id, reason) => args.acceptor.disconnectSession(id, reason),
  });
  sessionRegistry.installSubscribers();

  const throttle = new NoSessionReplyThrottle(args.clock, args.noSessionIntervalMs);

  const dispatcher = new InboundDispatcher({
    tg: args.tg,
    eventBus: args.eventBus,
    clock: args.clock,
    acceptor: args.acceptor,
    adminAllowlist: args.adminAllowlist,
    registrationGate: args.registrationGate,
    statusReporter: args.statusReporter,
    pendingRegistry: args.pendingRegistry,
    sessionRegistry,
    adminChatRegistry: args.adminChatRegistry,
    throttle,
    chatTypeCache: args.chatTypeCache,
  });
  dispatcher.install();

  return {
    dispose() {
      dispatcher.dispose();
      sessionRegistry.dispose();
      // Only dispose the handshake if WE installed it; otherwise main.ts owns lifecycle.
      if (waitForResetDispose) waitForResetDispose();
    },
    getSessionRegistry() {
      return sessionRegistry;
    },
    getThrottle() {
      return throttle;
    },
  };
}

export { SessionRegistry, type SessionEntry } from "./session-registry";
export { AdminChatRegistry } from "./admin-chat-registry";
export { NoSessionReplyThrottle } from "./no-session-throttle";
export { InboundDispatcher } from "./inbound-dispatcher";
export { WaitForResetHandshakeHandler } from "./wait-for-reset-handshake";
