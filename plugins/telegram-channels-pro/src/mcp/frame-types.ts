export interface SessionInitFrame {
  kind: "session_init";
  project_path?: string;
  branch?: string;
  shortid: string;
  // v1.1.0 additive — sha256(CLAUDE_PROJECT_PATH).slice(0,16); used by daemon for
  // REQ-045 reconnect classification (matches against scriptedReconnectMap).
  proxy_id?: string;
}

// v1.1.0 — REQ-033 channel notification frame (daemon → proxy → MCP notification).
export interface ChannelNotificationFrame {
  kind: "channel_notification";
  text: string;
  image_path?: string;
  attachment_file_id?: string;
  chat_id: number;
  message_id: number;
  user: string;
  ts: number;
}

// v1.1.0 — REQ-045 reload-handshake (proxy → daemon, sent on existing socket before close).
export interface WillReconnectFrame {
  kind: "will_reconnect";
  proxy_id: string;
  reason: "reload_plugins";
}

// v1.1.0 — REQ-037 + Decision A18 (M002 quarantine_replay_resolved event → daemon → proxy MCP notification).
export interface QuarantineReplyResolvedNotificationFrame {
  kind: "quarantine_reply_resolved";
  requester_session: string;
  message_id?: number;
  delivered: boolean;
  queued_at: number;
  replayed_at: number;
  error_class?: string;
}

// v1.1.0 — REQ-045 + Decision A18 (M002 quarantine_enter/exit event → daemon → proxy MCP notification).
export interface QuarantineStateChangedFrame {
  kind: "quarantine_state_changed";
  state: "quarantine_enter" | "quarantine_exit";
  eta_hint: number;
}

export interface ToolCallFrame {
  kind: "tool_call";
  request_id: string;
  tool: string;
  params: unknown;
}

export interface ToolResultFrame {
  kind: "tool_result";
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface InboundPushFrame {
  kind: "inbound_push";
  type: "message" | "callback_query";
  payload: unknown;
}

export type DisconnectReason = "capacity_exceeded" | "session_terminated" | "daemon_stop" | "admin_rejected";

export interface DisconnectFarewellFrame {
  kind: "disconnect_farewell";
  reason: DisconnectReason;
}

export type AnyFrame =
  | SessionInitFrame
  | ToolCallFrame
  | ToolResultFrame
  | InboundPushFrame
  | DisconnectFarewellFrame
  | ChannelNotificationFrame
  | WillReconnectFrame
  | QuarantineReplyResolvedNotificationFrame
  | QuarantineStateChangedFrame;

export function isChannelNotificationFrame(x: unknown): x is ChannelNotificationFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "channel_notification" &&
    typeof (x as { text?: unknown }).text === "string" &&
    typeof (x as { chat_id?: unknown }).chat_id === "number" &&
    typeof (x as { message_id?: unknown }).message_id === "number"
  );
}

export function isWillReconnectFrame(x: unknown): x is WillReconnectFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "will_reconnect" &&
    typeof (x as { proxy_id?: unknown }).proxy_id === "string"
  );
}

export function isQuarantineReplyResolvedFrame(x: unknown): x is QuarantineReplyResolvedNotificationFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "quarantine_reply_resolved" &&
    typeof (x as { requester_session?: unknown }).requester_session === "string" &&
    typeof (x as { delivered?: unknown }).delivered === "boolean"
  );
}

export function isQuarantineStateChangedFrame(x: unknown): x is QuarantineStateChangedFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "quarantine_state_changed" &&
    ((x as { state?: unknown }).state === "quarantine_enter" || (x as { state?: unknown }).state === "quarantine_exit") &&
    typeof (x as { eta_hint?: unknown }).eta_hint === "number"
  );
}

export function isSessionInitFrame(x: unknown): x is SessionInitFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "session_init" &&
    typeof (x as { shortid?: unknown }).shortid === "string"
  );
}

export function isToolCallFrame(x: unknown): x is ToolCallFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "tool_call" &&
    typeof (x as { request_id?: unknown }).request_id === "string" &&
    typeof (x as { tool?: unknown }).tool === "string"
  );
}
