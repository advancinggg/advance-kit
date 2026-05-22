import type { TelegramAPIClient } from "../telegram/client";
import type { PollingStatusImpl } from "../telegram/polling-status";
import type { ChatTypeCache, ChatType } from "../telegram/chat-type-cache";
import { ChatTypeFetchError } from "../telegram/chat-type-cache";
import type { EventBus } from "../daemon/event-bus";
import { uploadAttachment } from "./internal-multipart";

export interface ReplyParams {
  chat_id: number | string;
  text?: string;
  reply_to?: number;
  reply_markup?: unknown;
  files?: string[];
}

export interface ReplyContext {
  tg: TelegramAPIClient;
  apiBase: string;
  token: string;
  pollingStatus: PollingStatusImpl;
  // v1.1.0 — REQ-035 outbound chat-type DiD.
  chatTypeCache: ChatTypeCache;
  // v1.1.0 — REQ-035 audit-event emit channel (CONTRACT-003 outbound_chat_type_denied).
  eventBus: EventBus;
  // v1.1.0 — REQ-037: MCP sessionId propagated into sendMessage opts.requester_session so
  // the quarantine outbound replay queue can route per-session on drain.
  sessionId?: string;
  fetchFn?: typeof globalThis.fetch;
}

export type ReplyResult =
  | { delivered: true; message_id: number }
  | { delivered: false; queued: true; eta_hint: number }
  | { delivered: false; error: string; retry_after_sec?: number };

/**
 * v1.1.0 — chat_id normalization for outbound chat-type DiD (REQ-035 AC-20).
 *
 * - `number` → use directly.
 * - Numeric string within safe-integer range → parse via Number().
 * - Non-numeric (@username), out-of-safe-range, garbage → returns null. The caller
 *   denies with InvalidChatTypeError envelope per AC-20 strict reading (treat
 *   "cannot prove private" as "non-private"). Safe-integer boundary uses BigInt to
 *   avoid lossy parsing of huge integer strings.
 */
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
 * `reply` MCP tool: text-only goes via M002.sendMessage; attachments via
 * M004-internal multipart helper (CCD-1).
 *
 * v1.1.0 — REQ-035 outbound chat-type defense-in-depth (AC-20/21/29): the chat-type
 * gate fires at the TOP of the handler, before any TG API call. Returns a structured
 * `{delivered: false, error: 'InvalidChatTypeError'}` envelope on denial (no throw),
 * per the M004 envelope-shape convention.
 *
 * v1.1.0 — REQ-037: the text-only path propagates `ctx.sessionId` to `tg.sendMessage`
 * via the `requester_session` opts metadata so the quarantine replay queue can route
 * per-session on drain.
 */
export async function reply(params: ReplyParams, ctx: ReplyContext): Promise<ReplyResult> {
  if (params.chat_id === undefined || params.chat_id === null) {
    return { delivered: false, error: "missing_chat_id" };
  }

  // REQ-035 chat-type DiD gate (AC-20/21/29).
  const chatIdNumeric = normalizeChatId(params.chat_id);
  if (chatIdNumeric === null) {
    // @username, out-of-safe-range, or garbage: cannot verify chat type → deny.
    ctx.eventBus.emit("outbound_chat_type_denied", {
      chat_id: -1,
      observed_type: "unresolvable",
      tool: "reply",
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
        tool: "reply",
      });
      return { delivered: false, error: "InvalidChatTypeError" };
    }
    throw e;
  }
  if (observedType !== "private") {
    ctx.eventBus.emit("outbound_chat_type_denied", {
      chat_id: chatIdNumeric,
      observed_type: observedType,
      tool: "reply",
    });
    return { delivered: false, error: "InvalidChatTypeError" };
  }

  const hasText = typeof params.text === "string" && params.text.length > 0;
  const hasFiles = Array.isArray(params.files) && params.files.length > 0;
  if (!hasText && !hasFiles) {
    return { delivered: false, error: "missing_text_or_files" };
  }
  if (hasFiles) {
    // Send first attachment with caption=text; subsequent files sent separately without caption.
    const files = params.files!;
    let firstResult: ReplyResult | null = null;
    for (let i = 0; i < files.length; i++) {
      const isFirst = i === 0;
      const env = await uploadAttachment({
        apiBase: ctx.apiBase,
        token: ctx.token,
        chat_id: params.chat_id,
        file_path: files[i]!,
        caption: isFirst ? params.text : undefined,
        reply_to_message_id: isFirst ? params.reply_to : undefined,
        pollingStatus: ctx.pollingStatus,
        fetchFn: ctx.fetchFn,
      });
      const result = envelopeToResult(env);
      if (isFirst) firstResult = result;
      // If any send fails, short-circuit and return the failure
      if (!isFirst && (!("delivered" in result) || result.delivered !== true)) {
        return result;
      }
    }
    return firstResult!;
  }
  // Text-only path. v1.1.0 — REQ-037 sessionId propagation via opts.requester_session.
  const env = await ctx.tg.sendMessage(
    {
      chat_id: params.chat_id,
      text: params.text!,
      reply_to_message_id: params.reply_to,
      reply_markup: params.reply_markup,
    },
    ctx.sessionId !== undefined ? { requester_session: ctx.sessionId } : undefined,
  );
  return envelopeToResult(env);
}

function envelopeToResult(env: Awaited<ReturnType<TelegramAPIClient["sendMessage"]>>): ReplyResult {
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
    return { delivered: false, error: "capacity_exceeded" };
  }
  return { delivered: false, error: "unknown" };
}
