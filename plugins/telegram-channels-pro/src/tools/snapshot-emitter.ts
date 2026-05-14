import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { PendingApprovalRegistryImpl } from "./pending-registry";

const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

export interface SnapshotEmitterConfig {
  registry: PendingApprovalRegistryImpl;
  eventBus: EventBus;
  clock: Clock;
  intervalMs?: number;
}

/**
 * Periodic emitter for `pending_capacity_snapshot` events. M008 StatusReporter
 * subscribes via Subscriber to keep the cached `pending_approvals` field fresh
 * even when no add/resolve/cleanup is happening (Decision A12 / AC-13).
 */
export class SnapshotEmitter {
  private cfg: Required<SnapshotEmitterConfig>;
  private timer: TimerHandle | null = null;

  constructor(cfg: SnapshotEmitterConfig) {
    this.cfg = {
      intervalMs: DEFAULT_SNAPSHOT_INTERVAL_MS,
      ...cfg,
    };
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      this.cfg.eventBus.emit("pending_capacity_snapshot", {
        current: this.cfg.registry.size(),
        max: this.cfg.registry.capacity(),
      });
      this.timer = this.cfg.clock.setTimeout(tick, this.cfg.intervalMs);
    };
    this.timer = this.cfg.clock.setTimeout(tick, this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }
}
