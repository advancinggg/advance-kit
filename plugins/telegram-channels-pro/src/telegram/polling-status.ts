import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { PollingState } from "../daemon/event-types";

export interface PollingSnapshot {
  state: PollingState;
  last_inbound_ts: number | null;
  fatal_window_count: number;
  current_offset: number;
  since_state_change_ms: number;
}

const SNAPSHOT_CADENCE_MS = 30_000;

export class PollingStatusImpl {
  private state: PollingState = "running";
  private lastInboundTs: number | null = null;
  private fatalWindowCount = 0;
  private currentOffset = 0;
  private stateChangedAt: number;
  private snapshotTimer: TimerHandle | null = null;

  constructor(private clock: Clock, private eventBus: EventBus) {
    this.stateChangedAt = this.clock.now();
    this.snapshotTimer = this.clock.setInterval(() => this.emitSnapshot(), SNAPSHOT_CADENCE_MS);
    this.eventBus.on("daemon_stop", () => this.stop());
  }

  stop(): void {
    if (this.snapshotTimer) {
      this.snapshotTimer.cancel();
      this.snapshotTimer = null;
    }
  }

  setState(next: PollingState): void {
    if (this.state !== next) {
      this.state = next;
      this.stateChangedAt = this.clock.now();
      this.emitSnapshot();
    }
  }

  noteInbound(ts: number): void {
    this.lastInboundTs = ts;
  }

  setFatalWindowCount(n: number): void {
    this.fatalWindowCount = n;
  }

  setOffset(n: number): void {
    this.currentOffset = n;
  }

  getSnapshot(): PollingSnapshot {
    return {
      state: this.state,
      last_inbound_ts: this.lastInboundTs,
      fatal_window_count: this.fatalWindowCount,
      current_offset: this.currentOffset,
      since_state_change_ms: this.clock.now() - this.stateChangedAt,
    };
  }

  /** Test-visible alias for the periodic emit. */
  emitSnapshot(): void {
    this.eventBus.emit("polling_status_snapshot", this.getSnapshot());
  }
}
