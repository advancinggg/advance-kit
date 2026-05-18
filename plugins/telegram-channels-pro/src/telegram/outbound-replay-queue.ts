import { QUARANTINE_QUEUE_CAP } from "./client";

export class CapacityExceededError extends Error {
  constructor(capacity: number) {
    super(`OutboundReplayQueue capacity ${capacity} exceeded`);
    this.name = "CapacityExceededError";
  }
}

export interface OutboundReplayQueueConfig {
  capacity?: number;
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

  constructor(cfg: OutboundReplayQueueConfig = {}) {
    this.capacity = cfg.capacity ?? QUARANTINE_QUEUE_CAP;
  }

  enqueue(entry: unknown): { queued: true } {
    if (this.entries.length >= this.capacity) {
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
