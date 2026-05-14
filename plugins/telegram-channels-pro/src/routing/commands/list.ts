import type { TelegramAPIClient } from "../../telegram/client";
import type { Clock } from "../../daemon/clock";
import type { EventBus } from "../../daemon/event-bus";
import type { SessionRegistry, SessionEntry } from "../session-registry";

/**
 * `/list` command handler. Returns each registry entry as
 * `<shortid> <branch> <ago>` (no project path per PRD §4.6).
 *
 * NOT subject to NoSessionReplyThrottle (PRD §4.6 invariant — verified by AC-16).
 */
export async function handleListCommand(args: {
  chatId: number | string;
  updateId: number;
  tg: TelegramAPIClient;
  eventBus: EventBus;
  registry: SessionRegistry;
  clock: Clock;
}): Promise<void> {
  const { chatId, updateId, tg, eventBus, registry, clock } = args;
  const entries = registry.entries();
  let text: string;
  if (entries.length === 0) {
    text = "No sessions registered. Start with `claude --channels telegram`.";
  } else {
    const now = clock.now();
    const lines = entries.map((e) => formatEntry(e, now));
    text = lines.join("\n");
  }
  await tg.sendMessage({ chat_id: chatId, text });
  eventBus.emit("route_decision", {
    update_id: updateId,
    target_session: null,
    reason: "command_handled",
  });
}

function formatEntry(entry: SessionEntry, now: number): string {
  const ago = humanizeAgo(now - entry.last_activity_at);
  return `${entry.shortid} ${entry.branch || "(no-branch)"} ${ago}`;
}

function humanizeAgo(deltaMs: number): string {
  if (deltaMs < 0) deltaMs = 0;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
