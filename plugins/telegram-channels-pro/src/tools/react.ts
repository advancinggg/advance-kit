import type { PollingStatusImpl } from "../telegram/polling-status";
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
  fetchFn?: typeof globalThis.fetch;
}

export type ReactResult = { ok: true } | { ok: false; error: string };

/**
 * `react` MCP tool: calls Telegram's `setMessageReaction` via M004-internal helper.
 */
export async function react(params: ReactParams, ctx: ReactContext): Promise<ReactResult> {
  if (!params.emoji || !params.chat_id || !params.message_id) {
    return { ok: false, error: "missing_params" };
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
