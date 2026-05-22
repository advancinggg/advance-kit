import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import { QUARANTINE_QUEUE_CAP } from "./client";
import type { SendMessageReq } from "./methods";

export class CapacityExceededError extends Error {
  constructor(capacity: number) {
    super(`OutboundReplayQueue capacity ${capacity} exceeded`);
    this.name = "CapacityExceededError";
  }
}

/**
 * v1.1.0 — REQ-037 QueueEntry. `requester_session` is REQUIRED so that on drain the
 * emitted `quarantine_replay_resolved` event payload (CONTRACT-003) carries the session id
 * required by the M003 forwarder (`tgcp/quarantine/reply_resolved` MCP notification).
 * `params` preserves the full SendMessageReq so the replay POST is byte-equivalent to the
 * original (including reply_markup, parse_mode, reply_to_message_id).
 */
export interface QueueEntry {
  requester_session: string;
  params: SendMessageReq;
  queued_at: number;
}

/**
 * v1.1.0 — REQ-037 drain replay function. Caller (polling-loop) supplies a function that
 * performs the actual TG POST for each entry. The queue handles FIFO walk + event emission;
 * the replay function returns delivery outcome (success: message_id; failure: error_class).
 */
export type ReplayFn = (entry: QueueEntry) => Promise<{
  delivered: boolean;
  message_id?: number;
  error_class?: string;
}>;

export interface OutboundReplayQueueConfig {
  capacity?: number;
  /**
   * v1.1.0 — REQ-037 drain needs the EventBus to emit `quarantine_replay_resolved` per
   * replayed entry, AND to emit the legacy `outbound_replay_queue_capacity_exceeded` WARN
   * log_emit event on cap-exceeded. Kept optional for back-compat with the AC-34 cap-only
   * test which doesn't inject one (cap-exceeded throw still works without the seam).
   */
  eventBus?: EventBus;
  /**
   * v1.1.0 — REQ-037 AC-29 requires `replayed_at` in the emitted event payload. drain
   * sources timestamps from this injected clock. REQUIRED for drain to fire correctly.
   * Tests that exercise enqueue-only paths can inject `realClock()`.
   */
  clock?: Clock;
}

/**
 * v1.1.0 — REQ-037 quarantine outbound replay queue.
 *
 * Stores REQ-037 entries (FIFO) up to 50-cap (REQ-022 AC-34 third cap). On `quarantine_exit`
 * the polling-loop calls `drain(replayFn)` to walk FIFO, invoke the replayFn per entry, and
 * emit `quarantine_replay_resolved` events. Entries lost on daemon restart (AC-30 — in-memory
 * only, no persistence).
 *
 * AC-34 cap behavior preserved: enqueue throws `CapacityExceededError` at cap-exceeded.
 * AC-34 cap-independence test uses typed entries via QueueEntry interface (v1.1.0 update).
 */
export class OutboundReplayQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly capacity: number;
  private readonly eventBus?: EventBus;
  private readonly clock?: Clock;

  constructor(cfg: OutboundReplayQueueConfig = {}) {
    this.capacity = cfg.capacity ?? QUARANTINE_QUEUE_CAP;
    this.eventBus = cfg.eventBus;
    this.clock = cfg.clock;
  }

  /**
   * v1.1.0 enqueue: returns void (caller infers success from no-throw). Throws
   * `CapacityExceededError` on cap-exceeded, AFTER emitting the legacy WARN log_emit
   * audit event when an EventBus is configured.
   *
   * AC-34 unit test calls `q.enqueue(entry)` without consuming a return — preserved.
   */
  enqueue(entry: QueueEntry): void {
    if (this.entries.length >= this.capacity) {
      this.eventBus?.emit("log_emit", {
        level: "WARN",
        event_type: "outbound_replay_queue_capacity_exceeded",
        fields: { capacity: this.capacity, current_size: this.entries.length },
      });
      throw new CapacityExceededError(this.capacity);
    }
    this.entries.push(entry);
  }

  /**
   * v1.1.0 — REQ-037 AC-29 drain. Walks entries in FIFO order, invokes replayFn per entry,
   * emits `quarantine_replay_resolved` per call with full payload schema. Clears entries on
   * completion (whether each replay succeeded or failed — REQ-037 §1.4.6 step 6 best-effort
   * semantics).
   *
   * Polling-loop calls this from the probe-success branch immediately AFTER setting
   * `pollingStatus.setState('running')` so the replayFn's downstream `tgClient.sendMessage`
   * takes the real-POST path (NOT the quarantine stub).
   */
  async drain(replayFn: ReplayFn, shouldAbort?: () => boolean): Promise<void> {
    // Pop entries one at a time (shift) rather than snapshot-clear-all, so that if the
    // caller aborts mid-drain (daemon_stop) the un-replayed entries REMAIN in the queue
    // instead of being silently dropped. Each replay either delivers or emits a
    // `quarantine_replay_resolved{delivered:false}` event — no silent loss within a drain.
    while (this.entries.length > 0) {
      // Honor a graceful-shutdown request between entries: leave the rest queued.
      if (shouldAbort?.()) return;
      const entry = this.entries.shift()!;
      let result: Awaited<ReturnType<ReplayFn>>;
      try {
        result = await replayFn(entry);
      } catch (e) {
        // replayFn shouldn't throw (it returns structured outcome), but be defensive: a
        // thrown error means delivery failed with an unknown error_class.
        result = { delivered: false, error_class: (e as Error)?.message ?? "unknown" };
      }
      const replayed_at = this.clock?.now() ?? Date.now();
      this.eventBus?.emit("quarantine_replay_resolved", {
        requester_session: entry.requester_session,
        ...(result.message_id !== undefined ? { message_id: result.message_id } : {}),
        delivered: result.delivered,
        queued_at: entry.queued_at,
        replayed_at,
        ...(result.error_class !== undefined ? { error_class: result.error_class } : {}),
      });
    }
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
