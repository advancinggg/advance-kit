import type { TelegramAPIClient } from "../telegram/client";

export interface EditMessageParams {
  chat_id: number | string;
  message_id: number;
  text: string;
}

export interface EditMessageContext {
  tg: TelegramAPIClient;
}

export type EditMessageResult =
  | { delivered: true; message_id: number }
  | { delivered: false; queued: true; eta_hint: number }
  | { delivered: false; error: string; retry_after_sec?: number };

/**
 * `edit_message` MCP tool: thin wrapper over M002.editMessageText.
 */
export async function editMessage(
  params: EditMessageParams,
  ctx: EditMessageContext,
): Promise<EditMessageResult> {
  if (!params.chat_id || !params.message_id || typeof params.text !== "string") {
    return { delivered: false, error: "missing_params" };
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
  return { delivered: false, error: "unknown" };
}
