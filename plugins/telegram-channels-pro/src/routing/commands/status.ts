import type { TelegramAPIClient } from "../../telegram/client";
import type { EventBus } from "../../daemon/event-bus";
import type { StatusReporter, StatusSnapshot } from "../../obs/status-reporter";

/**
 * `/status` command handler. Calls M008 StatusReporter.getSnapshot() (CONTRACT-014)
 * and formats output per MODULE-007 §1.4.4 template.
 */
export async function handleStatusCommand(args: {
  chatId: number | string;
  updateId: number;
  tg: TelegramAPIClient;
  eventBus: EventBus;
  statusReporter: StatusReporter;
}): Promise<void> {
  const { chatId, updateId, tg, eventBus, statusReporter } = args;
  const snap = statusReporter.getSnapshot();
  const text = formatStatus(snap);
  await tg.sendMessage({ chat_id: chatId, text });
  eventBus.emit("route_decision", {
    update_id: updateId,
    target_session: null,
    reason: "command_handled",
  });
}

function formatStatus(s: StatusSnapshot): string {
  const lastInbound = s.last_inbound_ts !== null
    ? `${formatAgo(Date.now() - s.last_inbound_ts)} ago`
    : "never";
  return [
    "Daemon status",
    `  Uptime:                 ${formatUptime(s.uptime_seconds)}`,
    `  Deployment mode:        ${s.deployment_mode}`,
    `  Polling state:          ${s.polling_state}`,
    `  Last inbound:           ${lastInbound}`,
    `  Quarantine:             ${s.quarantine_active ? "yes" : "no"}`,
    `  Registered sessions:    ${s.registered_sessions}`,
    `  Pending approvals:      ${s.pending_approvals.current} / ${s.pending_approvals.max}`,
    `  Admin source:           ${s.admin_source}`,
  ].join("\n");
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatAgo(deltaMs: number): string {
  if (deltaMs < 0) deltaMs = 0;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${String(sec).padStart(2, "0")}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${String(min).padStart(2, "0")}:${String(remSec).padStart(2, "0")}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${String(hr).padStart(2, "0")}:${String(remMin).padStart(2, "0")}:${String(remSec).padStart(2, "0")}`;
}
