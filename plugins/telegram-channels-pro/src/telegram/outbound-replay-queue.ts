import type { EventBus } from "../daemon/event-bus";
import { QUARANTINE_QUEUE_CAP } from "./client";

export class CapacityExceededError extends Error {
  constructor(capacity: number) {
    super(`OutboundReplayQueue capacity ${capacity} exceeded`);
    this.name = "CapacityExceededError";
  }
}

export interface OutboundReplayQueueConfig {
  capacity?: number;
  /**
   * Optional — when injected, the queue emits a `log_emit` WARN event
   * named `outbound_replay_queue_capacity_exceeded` immediately before
   * throwing `CapacityExceededError`. Provides the audit trail M008
   * observability needs (parallel to the `pending_capacity_snapshot` /
   * admin-alert path on the pending-approval registry). The AC-34 unit
   * test does NOT inject one — the cap-only verification surface does
   * not require the event seam; production wiring (when REQ-037 lands)
   * will pass the daemon's EventBus.
   */
  eventBus?: EventBus;
}

/**
 * Minimal cap-only quarantine outbound replay queue.
 *
 * Satisfies the unit-test verification of REQ-022 AC-34 — that the
 * quarantine queue 50-cap is an independent counter from the
 * SessionRegistry 8-cap (REQ-022 sessions) and the PendingApprovalRegistry
 * 50-cap (REQ-009 approvals). Each cap is independently configurable via
 * its constructor cfg, and lives in a distinct module path.
 *
 * The full quarantine replay/drain semantics (REQ-037 AC-28/29/30) — per-
 * session bookkeeping, drain on quarantine_exit, event emission — are a
 * separate verification surface tracked under their own AC IDs and are
 * not part of this slice's in_scope_ac_ids.
 */
export class OutboundReplayQueue {
  private readonly entries: unknown[] = [];
  private readonly capacity: number;
  private readonly eventBus?: EventBus;

  constructor(cfg: OutboundReplayQueueConfig = {}) {
    this.capacity = cfg.capacity ?? QUARANTINE_QUEUE_CAP;
    this.eventBus = cfg.eventBus;
  }

  enqueue(entry: unknown): { queued: true } {
    if (this.entries.length >= this.capacity) {
      // Emit an audit event BEFORE throwing — gives M008 observability a
      // hook to count cap-exceeded drops (parallel to the pending-approval
      // registry's admin-alert path). Optional dependency; tests that
      // exercise the cap behavior without an EventBus continue to work.
      this.eventBus?.emit("log_emit", {
        level: "WARN",
        event_type: "outbound_replay_queue_capacity_exceeded",
        fields: { capacity: this.capacity, current_size: this.entries.length },
      });
      throw new CapacityExceededError(this.capacity);
    }
    this.entries.push(entry);
    return { queued: true };
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
