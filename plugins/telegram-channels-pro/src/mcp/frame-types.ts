export interface SessionInitFrame {
  kind: "session_init";
  project_path?: string;
  branch?: string;
  shortid: string;
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
  | DisconnectFarewellFrame;

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
