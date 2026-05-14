import type { TelegramAPIClient } from "../../telegram/client";
import type { EventBus } from "../../daemon/event-bus";
import type { SessionRegistry } from "../session-registry";

const SHORTID_REGEX = /^[a-f0-9]{1,12}$/;

/**
 * `/session <shortid>` command handler.
 *
 * - Validates `<shortid>` against `^[a-f0-9]{1,12}$` (REQ-015).
 * - On invalid input, replies "Invalid shortid format"; emits `route_decision: invalid_shortid`.
 * - On match, bubbles the matching session to LRU head; replies "Switched focus to <shortid>".
 * - On no match, replies "Session <shortid> not found".
 *
 * Reply text only echoes the validated input string (REQ-015 input-sanitization).
 */
export async function handleSessionCommand(args: {
  shortid: string;
  chatId: number | string;
  updateId: number;
  tg: TelegramAPIClient;
  eventBus: EventBus;
  registry: SessionRegistry;
}): Promise<void> {
  const { shortid, chatId, updateId, tg, eventBus, registry } = args;
  if (!SHORTID_REGEX.test(shortid)) {
    await tg.sendMessage({ chat_id: chatId, text: "Invalid shortid format" });
    eventBus.emit("route_decision", {
      update_id: updateId,
      target_session: null,
      reason: "invalid_shortid",
    });
    return;
  }
  const match = registry.findByShortIdPrefix(shortid);
  if (!match) {
    await tg.sendMessage({ chat_id: chatId, text: `Session ${shortid} not found` });
    eventBus.emit("route_decision", {
      update_id: updateId,
      target_session: null,
      reason: "command_handled",
    });
    return;
  }
  registry.bumpActivity(match.session_id);
  await tg.sendMessage({ chat_id: chatId, text: `Switched focus to ${shortid}` });
  eventBus.emit("route_decision", {
    update_id: updateId,
    target_session: match.session_id,
    reason: "command_handled",
  });
}
