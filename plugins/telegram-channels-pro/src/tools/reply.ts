import type { TelegramAPIClient } from "../telegram/client";
import type { PollingStatusImpl } from "../telegram/polling-status";
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
  fetchFn?: typeof globalThis.fetch;
}

export type ReplyResult =
  | { delivered: true; message_id: number }
  | { delivered: false; queued: true; eta_hint: number }
  | { delivered: false; error: string; retry_after_sec?: number };

/**
 * `reply` MCP tool: text-only goes via M002.sendMessage; attachments via
 * M004-internal multipart helper (CCD-1).
 */
export async function reply(params: ReplyParams, ctx: ReplyContext): Promise<ReplyResult> {
  if (params.chat_id === undefined || params.chat_id === null) {
    return { delivered: false, error: "missing_chat_id" };
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
  // Text-only path
  const env = await ctx.tg.sendMessage({
    chat_id: params.chat_id,
    text: params.text!,
    reply_to_message_id: params.reply_to,
    reply_markup: params.reply_markup,
  });
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
  return { delivered: false, error: "unknown" };
}
