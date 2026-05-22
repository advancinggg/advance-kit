import type { PollingStatusImpl } from "../telegram/polling-status";
import type { ChatTypeCache, ChatType } from "../telegram/chat-type-cache";
import { ChatTypeFetchError } from "../telegram/chat-type-cache";
import type { EventBus } from "../daemon/event-bus";
import { setReaction, type SetReactionResult } from "./internal-reaction";

export interface ReactParams {
  chat_id: number | string;
  message_id: number;
  emoji: string;
}

export interface ReactContext {
  apiBase: string;
  token: string;
  pollingStatus: PollingStatusImpl;
  // v1.1.0 — REQ-035 outbound chat-type DiD.
  chatTypeCache: ChatTypeCache;
  eventBus: EventBus;
  fetchFn?: typeof globalThis.fetch;
}

export type ReactResult = { ok: true } | { ok: false; error: string };

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
 * `react` MCP tool: calls Telegram's `setMessageReaction` via M004-internal helper.
 *
 * v1.1.0 — REQ-035 outbound chat-type defense-in-depth (AC-20/21/29).
 */
export async function react(params: ReactParams, ctx: ReactContext): Promise<ReactResult> {
  if (!params.emoji || !params.chat_id || !params.message_id) {
    return { ok: false, error: "missing_params" };
  }

  // REQ-035 chat-type DiD gate.
  const chatIdNumeric = normalizeChatId(params.chat_id);
  if (chatIdNumeric === null) {
    ctx.eventBus.emit("outbound_chat_type_denied", {
      chat_id: -1,
      observed_type: "unresolvable",
      tool: "react",
    });
    return { ok: false, error: "InvalidChatTypeError" };
  }
  let observedType: ChatType;
  try {
    observedType = await ctx.chatTypeCache.getChatType(chatIdNumeric);
  } catch (e) {
    if (e instanceof ChatTypeFetchError) {
      ctx.eventBus.emit("outbound_chat_type_denied", {
        chat_id: chatIdNumeric,
        observed_type: "unknown",
        tool: "react",
      });
      return { ok: false, error: "InvalidChatTypeError" };
    }
    throw e;
  }
  if (observedType !== "private") {
    ctx.eventBus.emit("outbound_chat_type_denied", {
      chat_id: chatIdNumeric,
      observed_type: observedType,
      tool: "react",
    });
    return { ok: false, error: "InvalidChatTypeError" };
  }

  const result: SetReactionResult = await setReaction({
    apiBase: ctx.apiBase,
    token: ctx.token,
    chat_id: params.chat_id,
    message_id: params.message_id,
    emoji: params.emoji,
    pollingStatus: ctx.pollingStatus,
    fetchFn: ctx.fetchFn,
  });
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}
