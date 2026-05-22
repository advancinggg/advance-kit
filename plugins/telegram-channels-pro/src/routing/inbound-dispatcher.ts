import type { TelegramAPIClient } from "../telegram/client";
import type { EventBus } from "../daemon/event-bus";
import type { Clock } from "../daemon/clock";
import type { MCPDaemonAcceptor } from "../mcp/daemon-acceptor";
import type { AdminAllowlist } from "../auth/allowlist";
import type { RegistrationGate } from "../auth/registration-gate";
import type { StatusReporter } from "../obs/status-reporter";
import type { PendingApprovalRegistry } from "../tools/pending-registry";
import type { ChatTypeCache, ChatType } from "../telegram/chat-type-cache";
import { shortHash } from "../common/hash";
import { SessionRegistry } from "./session-registry";
import { AdminChatRegistry } from "./admin-chat-registry";
import { NoSessionReplyThrottle } from "./no-session-throttle";
import { handleSessionCommand } from "./commands/session";
import { handleListCommand } from "./commands/list";
import { handleStatusCommand } from "./commands/status";

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id?: number;
  from?: TgUser;
  chat?: TgChat;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from?: TgUser;
  message?: { chat?: TgChat; message_id?: number };
  data?: string;
}

export interface InboundDispatcherConfig {
  tg: TelegramAPIClient;
  eventBus: EventBus;
  clock: Clock;
  acceptor: MCPDaemonAcceptor;
  adminAllowlist: AdminAllowlist;
  registrationGate: RegistrationGate;
  statusReporter: StatusReporter;
  pendingRegistry: PendingApprovalRegistry;
  sessionRegistry: SessionRegistry;
  adminChatRegistry: AdminChatRegistry;
  throttle: NoSessionReplyThrottle;
  // v1.1.0 — REQ-035 AC-22: M005 primes CONTRACT-016 ChatTypeCache on EVERY inbound
  // (both message and callback_query branches) as the FIRST observable side-effect,
  // BEFORE any admin/registration routing. Forward-compatible with future REQ-034
  // chat-type inbound gate (out of scope for this slice).
  chatTypeCache: ChatTypeCache;
}

export class InboundDispatcher {
  private cfg: InboundDispatcherConfig;
  private unsubs: Array<() => void> = [];

  constructor(cfg: InboundDispatcherConfig) {
    this.cfg = cfg;
  }

  install(): void {
    const u1 = this.cfg.eventBus.on("inbound_update", (payload) => {
      void this.handleInbound(payload);
    });
    const u2 = this.cfg.eventBus.on("session_disconnected", (payload) => {
      const p = payload as { session_id: string };
      void this.cfg.pendingRegistry.cleanupBySession(p.session_id, this.cfg.tg);
    });
    this.unsubs.push(u1, u2);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private async handleInbound(payload: unknown): Promise<void> {
    const p = payload as { update_id?: number; type: "message" | "callback_query"; payload: unknown };
    const updateId = typeof p.update_id === "number" ? p.update_id : 0;
    // M002 emits payload as the WHOLE TG update object: { update_id, message?,
    // callback_query? }. Extract the inner part based on type.
    const update = p.payload as { message?: TgMessage; callback_query?: TgCallbackQuery };
    if (p.type === "message") {
      const msg = update.message;
      if (!msg) return; // malformed — type says message but no message field
      // REQ-035 AC-22: prime CONTRACT-016 ChatTypeCache as FIRST observable side-effect
      // before any routing. CONTRACT-016 caches ALL observed types (including non-private).
      this.primeCacheFromChat(msg.chat);
      await this.handleText(updateId, msg);
    } else if (p.type === "callback_query") {
      const cb = update.callback_query;
      if (!cb) return;
      // REQ-035 AC-22: prime cache for callback_query branch too.
      this.primeCacheFromChat(cb.message?.chat);
      await this.handleCallback(updateId, cb);
    }
  }

  /**
   * v1.1.0 — REQ-035 AC-22 prime helper. Writes any observed (chat_id, chat_type)
   * pair into the cache. Defensive: skips if chat or fields are missing.
   */
  private primeCacheFromChat(chat: TgChat | undefined): void {
    if (!chat || chat.id === undefined || !chat.type) return;
    this.cfg.chatTypeCache.primeCache(chat.id, chat.type as ChatType);
  }

  private async handleText(updateId: number, msg: TgMessage): Promise<void> {
    const senderId = msg.from?.id;
    const chatId = msg.chat?.id;
    const chatType = msg.chat?.type ?? "unknown";
    const text = msg.text ?? "";
    if (senderId === undefined || chatId === undefined) {
      return; // malformed
    }
    // Step 1: registration window check FIRST (before admin check)
    if (this.cfg.registrationGate.isInRegistrationWindow()) {
      const result = await Promise.resolve(
        this.cfg.registrationGate.processRegistrationDM(senderId, text),
      );
      if (result.kind !== "not_registration_dm") {
        // Registration in progress (success / fail / rate-limited) — terminal for this DM
        return;
      }
      // not_registration_dm during registration window: drop silently (no admin to route to)
      return;
    }
    // Step 2: admin verify
    if (!this.cfg.adminAllowlist.isAdmin(senderId)) {
      this.cfg.eventBus.emit("auth_deny_routing", {
        sender_hash: shortHash(String(senderId)),
        reason: "inbound_text_deny",
      });
      return;
    }
    // Step 2a: capture admin chat (private chats only — CCD-10 privilege-leak defense)
    this.cfg.adminChatRegistry.setFromInbound(chatId, chatType);
    // Step 3: command match
    if (text.startsWith("/session ") || text === "/session") {
      const arg = text.slice("/session".length).trim();
      await handleSessionCommand({
        shortid: arg,
        chatId,
        updateId,
        tg: this.cfg.tg,
        eventBus: this.cfg.eventBus,
        registry: this.cfg.sessionRegistry,
      });
      return;
    }
    if (text === "/list") {
      await handleListCommand({
        chatId,
        updateId,
        tg: this.cfg.tg,
        eventBus: this.cfg.eventBus,
        registry: this.cfg.sessionRegistry,
        clock: this.cfg.clock,
      });
      return;
    }
    if (text === "/status") {
      await handleStatusCommand({
        chatId,
        updateId,
        tg: this.cfg.tg,
        eventBus: this.cfg.eventBus,
        statusReporter: this.cfg.statusReporter,
      });
      return;
    }
    // Step 4: LRU dispatch (with stale-deliver fallback)
    await this.dispatchToFocus(updateId, chatId, msg);
  }

  private async dispatchToFocus(updateId: number, chatId: number, msg: TgMessage): Promise<void> {
    // Cap iterations defensively (audit Round 1 W2): with capacity 8, we'd never
    // need more than 8 iterations even if every session is stale; 16 leaves
    // room for reasonable headroom and prevents any infinite-loop bug.
    const MAX_FALLBACK_ITERATIONS = 16;
    for (let i = 0; i < MAX_FALLBACK_ITERATIONS; i++) {
      const focus = this.cfg.sessionRegistry.getFocus();
      if (!focus) {
        // No sessions — throttled no-session reply
        if (this.cfg.throttle.tryReply(chatId)) {
          await this.cfg.tg.sendMessage({
            chat_id: chatId,
            text: "No active claude session. Run `claude --channels telegram` to start one.",
          });
        }
        this.cfg.eventBus.emit("route_decision", {
          update_id: updateId,
          target_session: null,
          reason: "no_session",
        });
        return;
      }
      const result = await this.cfg.acceptor.deliverToSession(focus.session_id, {
        kind: "inbound_push",
        type: "message",
        payload: msg,
      });
      if (result.ok) {
        this.cfg.eventBus.emit("route_decision", {
          update_id: updateId,
          target_session: focus.session_id,
          reason: "text_delivered",
        });
        return;
      }
      // Stale session — remove and retry
      this.cfg.sessionRegistry.removeStale(focus.session_id);
      // loop continues with next focus
    }
    // Cap exceeded — emit log + no_session
    this.cfg.eventBus.emit("log_emit", {
      level: "WARN",
      event_type: "dispatch_fallback_cap_exceeded",
      fields: { update_id: updateId, max_iterations: MAX_FALLBACK_ITERATIONS },
    });
    this.cfg.eventBus.emit("route_decision", {
      update_id: updateId,
      target_session: null,
      reason: "no_session",
    });
  }

  private async handleCallback(updateId: number, cb: TgCallbackQuery): Promise<void> {
    const senderId = cb.from?.id;
    const callbackData = cb.data ?? "";
    if (senderId === undefined) return;
    // Admin verify FIRST
    if (!this.cfg.adminAllowlist.isAdmin(senderId)) {
      this.cfg.eventBus.emit("auth_deny_routing", {
        sender_hash: shortHash(String(senderId)),
        reason: "callback_deny",
      });
      // SILENT DROP — no answerCallbackQuery to attacker (PRD §3.3 / M005 §1.4.3)
      return;
    }
    // Lookup pending entry
    const entry = this.cfg.pendingRegistry.lookupByPendingId(callbackData);
    if (!entry) {
      // Stale post-crash button click → "approval expired"
      try {
        await this.cfg.tg.answerCallbackQuery({
          callback_query_id: cb.id,
          text: "approval expired",
          show_alert: true,
        });
      } catch {
        /* best-effort */
      }
      // Distinct reason vs callback_resolved (audit Round 1 Doc-C2)
      this.cfg.eventBus.emit("route_decision", {
        update_id: updateId,
        target_session: null,
        reason: "callback_stale",
      });
      return;
    }
    // Validate option_index bounded to options array (audit Round 1 W5 / adversarial)
    const optionLabel = entry.callback_data_map.get(callbackData);
    if (optionLabel === undefined) {
      // Crafted callback_data with valid pending_id but bogus index → treat as stale
      try {
        await this.cfg.tg.answerCallbackQuery({
          callback_query_id: cb.id,
          text: "invalid option",
          show_alert: true,
        });
      } catch {
        /* best-effort */
      }
      this.cfg.eventBus.emit("route_decision", {
        update_id: updateId,
        target_session: null,
        reason: "callback_invalid_option",
      });
      return;
    }
    // Resolve via M004 — ordering invariant: M004 dispatches answerCallbackQuery before resolving Promise
    await this.cfg.pendingRegistry.resolveApproval(
      entry.pending_id,
      optionLabel,
      cb.id,
      this.cfg.tg,
    );
    this.cfg.eventBus.emit("route_decision", {
      update_id: updateId,
      target_session: entry.requester_session_id,
      reason: "callback_resolved",
    });
  }
}
