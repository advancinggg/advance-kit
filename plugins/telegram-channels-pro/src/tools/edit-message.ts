import type { TelegramAPIClient } from "../telegram/client";
import type { ChatTypeCache, ChatType } from "../telegram/chat-type-cache";
import { ChatTypeFetchError } from "../telegram/chat-type-cache";
import type { EventBus } from "../daemon/event-bus";

export interface EditMessageParams {
  chat_id: number | string;
  message_id: number;
  text: string;
}

export interface EditMessageContext {
  tg: TelegramAPIClient;
  // v1.1.0 — REQ-035 outbound chat-type DiD.
  chatTypeCache: ChatTypeCache;
  eventBus: EventBus;
}

export type EditMessageResult =
  | { delivered: true; message_id: number }
  | { delivered: false; queued: true; eta_hint: number }
  | { delivered: false; error: string; retry_after_sec?: number };

function normalizeChatId(chat_id: number | string): number | null {
  if (typeof chat_id === "number") return chat_id;
  if (!/^-?\d+$/.test(chat_id)) return null;
  try {
    const bi = BigInt(chat_id);
    if (bi < BigInt(Number.MIN_SAFE_INTEGER) || bi > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(chat_id);
  } catch {
    return null;
  }
}

/**
 * `edit_message` MCP tool: thin wrapper over M002.editMessageText.
 *
 * v1.1.0 — REQ-035 outbound chat-type defense-in-depth (AC-20/21/29).
 */
export async function editMessage(
  params: EditMessageParams,
  ctx: EditMessageContext,
): Promise<EditMessageResult> {
  if (!params.chat_id || !params.message_id || typeof params.text !== "string") {
    return { delivered: false, error: "missing_params" };
  }

  // REQ-035 chat-type DiD gate.
  const chatIdNumeric = normalizeChatId(params.chat_id);
  if (chatIdNumeric === null) {
    ctx.eventBus.emit("outbound_chat_type_denied", {
      chat_id: -1,
      observed_type: "unresolvable",
      tool: "edit_message",
    });
    return { delivered: false, error: "InvalidChatTypeError" };
  }
  let observedType: ChatType;
  try {
    observedType = await ctx.chatTypeCache.getChatType(chatIdNumeric);
  } catch (e) {
    if (e instanceof ChatTypeFetchError) {
      ctx.eventBus.emit("outbound_chat_type_denied", {
        chat_id: chatIdNumeric,
        observed_type: "unknown",
        tool: "edit_message",
      });
      return { delivered: false, error: "InvalidChatTypeError" };
    }
    throw e;
  }
  if (observedType !== "private") {
    ctx.eventBus.emit("outbound_chat_type_denied", {
      chat_id: chatIdNumeric,
      observed_type: observedType,
      tool: "edit_message",
    });
    return { delivered: false, error: "InvalidChatTypeError" };
  }

  const env = await ctx.tg.editMessageText({
    chat_id: params.chat_id,
    message_id: params.message_id,
    text: params.text,
  });
  if (env.delivered) {
    return { delivered: true, message_id: env.message_id };
  }
  if ("queued" in env && env.queued) {
    return { delivered: false, queued: true, eta_hint: env.eta_hint };
  }
  if ("error" in env && env.error === "rate_limited") {
    return { delivered: false, error: "rate_limited", retry_after_sec: env.retry_after_sec };
  }
  if ("error" in env && env.error === "disconnected") {
    return { delivered: false, error: "disconnected" };
  }
  if ("error" in env && env.error === "capacity_exceeded") {
    // Type-defensive: editMessageText doesn't currently route through the queue, but the
    // SendMessageEnvelope union has the variant. Preserves union exhaustiveness for future.
    return { delivered: false, error: "capacity_exceeded" };
  }
  return { delivered: false, error: "unknown" };
}
