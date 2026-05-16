import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import { ALL_EVENT_TYPES, type EventTypeKey, type EventPayloadMap } from "../daemon/event-types";
import { redactPayload } from "./redaction";
import type { JsonLogger } from "./json-logger";
import type { AlertDispatcher } from "./alert-dispatcher";
import type { StatusReporter } from "./status-reporter";
import type { StateDir } from "../daemon/state-dir";

// Levels used per event type for the log line. Conservative: WARN for failure/anomaly,
// INFO for state transitions, DEBUG for high-rate events.
const LEVEL_BY_TYPE: Record<EventTypeKey, "DEBUG" | "INFO" | "WARN" | "ERROR"> = {
  inbound_update: "DEBUG",
  quarantine_enter: "WARN",
  quarantine_exit: "INFO",
  quarantine_replay_resolved: "INFO",
  polling_health: "DEBUG",
  polling_event: "WARN",
  polling_status_snapshot: "DEBUG",
  session_connected: "INFO",
  session_disconnected: "INFO",
  mcp_reconnect_classified: "INFO",
  frame_invalid: "WARN",
  tool_call: "DEBUG",
  tool_result: "DEBUG",
  pending_capacity_snapshot: "DEBUG",
  route_decision: "DEBUG",
  auth_deny_routing: "WARN",
  auth_deny_registration: "WARN",
  registration_event: "INFO",
  registration_timeout: "WARN",
  daemon_start: "INFO",
  daemon_stop: "INFO",
  lock_event: "WARN",
  watchdog_signal: "ERROR",
  state_dir_perms_anomaly: "WARN",
  cli_command: "INFO",
  subscriber_queue_drop: "WARN",
  log_emit: "INFO",
  alert_emit: "INFO",
  channel_notification_emitted: "DEBUG",
};

// Event types fed to the AlertDispatcher.
const ALERT_FEED: Set<EventTypeKey> = new Set([
  "quarantine_enter",
  "quarantine_exit",
  "watchdog_signal",
  "alert_emit",
  "auth_deny_routing",
  "auth_deny_registration",
  "daemon_start",
]);

export interface SubscriberConfig {
  eventBus: EventBus;
  logger: JsonLogger;
  alertDispatcher: AlertDispatcher;
  statusReporter: StatusReporter;
  clock: Clock;
  /** Buffer events while stateDir / logDir is not yet ready. */
  bufferCapacity?: number;
}

export class Subscriber {
  private cfg: Required<SubscriberConfig>;
  private buffered: Array<{ type: EventTypeKey; payload: unknown }> = [];
  private logReady = false;
  private unsubscribes: Array<() => void> = [];

  constructor(cfg: SubscriberConfig) {
    this.cfg = {
      bufferCapacity: 10_000,
      ...cfg,
    };
    this.installSubscriptions();
  }

  setStateDir(_sd: StateDir): void {
    this.logReady = true;
    // Drain buffer.
    for (const evt of this.buffered) this.processEvent(evt.type, evt.payload);
    this.buffered.length = 0;
  }

  private installSubscriptions(): void {
    for (const t of ALL_EVENT_TYPES) {
      const unsub = this.cfg.eventBus.on(t, (payload: unknown) => {
        if (!this.logReady) {
          if (this.buffered.length >= this.cfg.bufferCapacity) {
            this.buffered.shift();
          }
          this.buffered.push({ type: t, payload });
        } else {
          this.processEvent(t, payload);
        }
      });
      this.unsubscribes.push(unsub);
    }
  }

  private processEvent(type: EventTypeKey, payload: unknown): void {
    const redacted = redactPayload(payload) as Record<string, unknown>;
    // Build log entry. Canonical event_type identifies the kind of log line.
    // If the payload itself contains an `event_type` field (e.g., subscriber_queue_drop
    // payload includes which event_type was dropped), preserve it as `target_event_type`.
    const entry: Record<string, unknown> = {
      ts: this.cfg.clock.now(),
      level: LEVEL_BY_TYPE[type],
      event_type: type,
    };
    if (redacted && typeof redacted === "object") {
      for (const [k, v] of Object.entries(redacted)) {
        if (k === "event_type") entry.target_event_type = v;
        else if (k in entry) entry[`payload_${k}`] = v;
        else entry[k] = v;
      }
    }
    this.cfg.logger.append(entry as { ts: number; level: "DEBUG" | "INFO" | "WARN" | "ERROR"; event_type: string });
    if (ALERT_FEED.has(type)) {
      this.cfg.alertDispatcher.feedEvent(type, payload);
    }
    // Status reporter cache updates.
    switch (type) {
      case "polling_status_snapshot": {
        const p = payload as EventPayloadMap["polling_status_snapshot"];
        this.cfg.statusReporter.setPollingState(p.state);
        if (p.last_inbound_ts !== null) this.cfg.statusReporter.setLastInboundTs(p.last_inbound_ts);
        break;
      }
      case "session_connected":
        this.cfg.statusReporter.sessionConnected();
        break;
      case "session_disconnected":
        this.cfg.statusReporter.sessionDisconnected();
        break;
      case "pending_capacity_snapshot": {
        const p = payload as EventPayloadMap["pending_capacity_snapshot"];
        this.cfg.statusReporter.setPendingCapacity(p.current, p.max);
        break;
      }
      case "registration_event": {
        const p = payload as EventPayloadMap["registration_event"];
        if (p.kind === "skipped_env") this.cfg.statusReporter.setAdminSource("env");
        else if (p.kind === "skipped_file" || p.kind === "admin_registered") this.cfg.statusReporter.setAdminSource("file");
        else if (p.kind === "admin_reset") this.cfg.statusReporter.setAdminSource("none");
        break;
      }
      default:
        break;
    }
  }

  stop(): void {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }

  /** Test-visible: how many events are buffered pre-stateDir. */
  pendingBufferSize(): number {
    return this.buffered.length;
  }
}
