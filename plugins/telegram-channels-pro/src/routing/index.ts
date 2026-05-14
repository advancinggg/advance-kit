import type { TelegramAPIClient } from "../telegram/client";
import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { MCPDaemonAcceptor } from "../mcp/daemon-acceptor";
import type { AdminAllowlist } from "../auth/allowlist";
import type { RegistrationGate } from "../auth/registration-gate";
import type { StatusReporter } from "../obs/status-reporter";
import type { PendingApprovalRegistry } from "../tools/pending-registry";
import { SessionRegistry } from "./session-registry";
import { AdminChatRegistry } from "./admin-chat-registry";
import { NoSessionReplyThrottle } from "./no-session-throttle";
import { InboundDispatcher } from "./inbound-dispatcher";

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
  noSessionIntervalMs?: number;
  sessionCapacity?: number;
}

export interface RoutingCtx {
  dispose(): void;
  getSessionRegistry(): SessionRegistry;
  getThrottle(): NoSessionReplyThrottle;
}

export function installRouting(args: InstallRoutingArgs): RoutingCtx {
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
  });
  dispatcher.install();

  return {
    dispose() {
      dispatcher.dispose();
      sessionRegistry.dispose();
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
