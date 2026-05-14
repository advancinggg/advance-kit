export type EventTypeKey =
  | "inbound_update"
  | "quarantine_enter"
  | "quarantine_exit"
  | "polling_health"
  | "polling_event"
  | "polling_status_snapshot"
  | "session_connected"
  | "session_disconnected"
  | "frame_invalid"
  | "tool_call"
  | "tool_result"
  | "pending_capacity_snapshot"
  | "route_decision"
  | "auth_deny_routing"
  | "auth_deny_registration"
  | "registration_event"
  | "registration_timeout"
  | "daemon_start"
  | "daemon_stop"
  | "lock_event"
  | "watchdog_signal"
  | "state_dir_perms_anomaly"
  | "cli_command"
  | "subscriber_queue_drop"
  | "log_emit"
  | "alert_emit";

export type DeploymentMode = "launchd" | "lazy-spawn";

export type LockEventKind = "stale_takeover" | "contention_exit";
export type WatchdogKind = "orphan" | "stuck" | "idle";
export type WatchdogSeverity = "failure" | "normal";
export type PermsAnomalyAction = "restored" | "refused";
export type FrameInvalidKind = "oversize" | "malformed_json" | "pre_init" | "timeout";
export type PollingState = "running" | "quarantine" | "paused";
export type RegistrationEventKind =
  | "window_opened"
  | "window_closed_brute_force"
  | "admin_registered"
  | "admin_reset"
  | "timeout_lazy_spawn"
  | "timeout_launchd"
  | "skipped_env"
  | "skipped_file"
  | "waiting_for_reset";

export interface EventPayloadMap {
  inbound_update: { update_id: number; type: "message" | "callback_query"; payload: unknown };
  quarantine_enter: { reason: string; count_in_window: number; window_ms: number };
  quarantine_exit: { recovered_after_ms: number };
  polling_health: { ts: number; state: PollingState };
  polling_event: { kind: "conflict_409" | "rate_limited_429" | "transient_error"; detail?: unknown };
  polling_status_snapshot: {
    state: PollingState;
    last_inbound_ts: number | null;
    fatal_window_count: number;
    current_offset: number;
    since_state_change_ms: number;
  };
  session_connected: { session_id: string; shortid: string; branch?: string; ts: number };
  session_disconnected: { session_id: string; reason: string; uptime_ms: number };
  frame_invalid: { session_id: string | null; kind: FrameInvalidKind; detail?: string };
  tool_call: { session_id: string; request_id: string; tool: string };
  tool_result: { session_id: string; request_id: string; ok: boolean };
  pending_capacity_snapshot: { current: number; max: number };
  route_decision: { update_id: number; target_session: string | null; reason: string };
  auth_deny_routing: { sender_hash: string; reason: string };
  auth_deny_registration: { kind: "per_sender" | "global_trip"; sender_hash: string };
  registration_event: { kind: RegistrationEventKind; detail?: Record<string, unknown> };
  registration_timeout: { ts: number };
  daemon_start: { pid: number; boot_ts: number; bun_version: string; deployment_mode: DeploymentMode };
  daemon_stop: { pid: number; reason: string; uptime_ms: number };
  lock_event: { kind: LockEventKind; stale_pid?: number; observed_command?: string };
  watchdog_signal: { kind: WatchdogKind; severity: WatchdogSeverity; detail: Record<string, unknown> };
  state_dir_perms_anomaly: { path: string; expected: string; observed: string; action: PermsAnomalyAction };
  cli_command: { name: string; args: Record<string, unknown> };
  subscriber_queue_drop: { subscriber_id: string; event_type: EventTypeKey; drop_count: number };
  log_emit: { level: "DEBUG" | "INFO" | "WARN" | "ERROR"; event_type: string; fields: Record<string, unknown> };
  alert_emit: { severity: "warn" | "failure"; topic: string; detail?: unknown };
}

export const ALL_EVENT_TYPES: EventTypeKey[] = [
  "inbound_update",
  "quarantine_enter",
  "quarantine_exit",
  "polling_health",
  "polling_event",
  "polling_status_snapshot",
  "session_connected",
  "session_disconnected",
  "frame_invalid",
  "tool_call",
  "tool_result",
  "pending_capacity_snapshot",
  "route_decision",
  "auth_deny_routing",
  "auth_deny_registration",
  "registration_event",
  "registration_timeout",
  "daemon_start",
  "daemon_stop",
  "lock_event",
  "watchdog_signal",
  "state_dir_perms_anomaly",
  "cli_command",
  "subscriber_queue_drop",
  "log_emit",
  "alert_emit",
];

export type Unsubscribe = () => void;
