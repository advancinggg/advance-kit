import { randomBytes } from "node:crypto";
import type { TelegramAPIClient } from "../telegram/client";
import type { Clock } from "../daemon/clock";
import type { PendingApprovalRegistryImpl } from "./pending-registry";
import type { AdminChatRegistry } from "../routing/admin-chat-registry";

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 1;

export interface RequestApprovalParams {
  text: string;
  options: string[];
}

export interface RequestApprovalContext {
  tg: TelegramAPIClient;
  registry: PendingApprovalRegistryImpl;
  adminChatRegistry: AdminChatRegistry;
  clock: Clock;
  requesterSessionId: string;
}

export type RequestApprovalResult =
  | { ok: true; result: { choice: string; pending_id: string } }
  | { ok: false; error: string; hint?: string };

/**
 * `request_approval` MCP tool: send inline-button message to admin chat,
 * await admin click, return resolved choice. CapacityExceededError when
 * registry is full (>=50 pending). NoAdminChatConfigured when AdminChatRegistry
 * has not yet been bootstrapped (env unset + no admin DM seen yet).
 */
export async function requestApproval(
  params: RequestApprovalParams,
  ctx: RequestApprovalContext,
): Promise<RequestApprovalResult> {
  // Resolve admin chat (CCD-4)
  const adminChat = ctx.adminChatRegistry.get();
  if (adminChat === null) {
    return {
      ok: false,
      error: "NoAdminChatConfigured",
      hint: "send the bot any DM as admin first OR set TG_ADMIN_CHAT_ID env",
    };
  }
  // Validate options
  if (!Array.isArray(params.options)) {
    return { ok: false, error: "InvalidOptionsLength" };
  }
  if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
    return { ok: false, error: "InvalidOptionsLength" };
  }
  if (typeof params.text !== "string" || params.text.length === 0) {
    return { ok: false, error: "missing_text" };
  }
  // Allocate pending_id (16 bytes random hex = 32 chars)
  const pendingId = randomBytes(16).toString("hex");
  // Build callback_data per option: cb_<pid>_<idx>
  const callbackDataMap = new Map<string, string>();
  const inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < params.options.length; i++) {
    const cb = `cb_${pendingId}_${i}`;
    callbackDataMap.set(cb, params.options[i]!);
    inlineKeyboard.push([{ text: params.options[i]!, callback_data: cb }]);
  }
  // Send via M002 sendMessage with inline_keyboard
  const env = await ctx.tg.sendMessage({
    chat_id: adminChat,
    text: params.text,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
  if (!env.delivered) {
    if ("queued" in env && env.queued) {
      return { ok: false, error: "queued_quarantine" };
    }
    if ("error" in env) {
      return { ok: false, error: env.error };
    }
    return { ok: false, error: "send_failed" };
  }
  // Insert into registry — capacity check + Promise allocation
  const addResult = ctx.registry.add({
    pending_id: pendingId,
    requester_session_id: ctx.requesterSessionId,
    message_id: env.message_id,
    chat_id: adminChat,
    callback_data_map: callbackDataMap,
    options: params.options,
    created_at: ctx.clock.now(),
  });
  if (!addResult.ok) {
    // CapacityExceededError — but we already sent the message. Best to edit
    // the inline-button text to reflect cancellation and surface the error.
    try {
      await ctx.tg.editMessageText({
        chat_id: adminChat,
        message_id: env.message_id,
        text: "(approval cancelled — capacity exceeded)",
      });
    } catch {
      /* best-effort */
    }
    return { ok: false, error: "CapacityExceededError" };
  }
  // Await admin's click (Promise resolves via M005 → resolveApproval call path)
  let choice: string;
  try {
    choice = await addResult.promise;
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? "rejected" };
  }
  return { ok: true, result: { choice, pending_id: pendingId } };
}
