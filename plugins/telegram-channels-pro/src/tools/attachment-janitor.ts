import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";

const DEFAULT_TTL_HOURS = 6;
const DEFAULT_INTERVAL_MIN = 5;
const TTL_HOURS_MIN = 1;
const TTL_HOURS_MAX = 24;

export interface AttachmentJanitorConfig {
  stateDir: StateDir;
  eventBus: EventBus;
  clock: Clock;
  ttlHours?: number;
  intervalMin?: number;
}

export class AttachmentJanitor {
  private cfg: Required<AttachmentJanitorConfig>;
  private timer: TimerHandle | null = null;

  constructor(cfg: AttachmentJanitorConfig) {
    let ttl = cfg.ttlHours ?? DEFAULT_TTL_HOURS;
    if (ttl < TTL_HOURS_MIN) ttl = TTL_HOURS_MIN;
    if (ttl > TTL_HOURS_MAX) ttl = TTL_HOURS_MAX;
    this.cfg = {
      stateDir: cfg.stateDir,
      eventBus: cfg.eventBus,
      clock: cfg.clock,
      ttlHours: ttl,
      intervalMin: cfg.intervalMin ?? DEFAULT_INTERVAL_MIN,
    };
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.cfg.intervalMin * 60_000;
    const tick = (): void => {
      try {
        this.sweepOnce();
      } catch {
        /* sweep is best-effort */
      }
      this.timer = this.cfg.clock.setTimeout(tick, intervalMs);
    };
    this.timer = this.cfg.clock.setTimeout(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }

  /** Run one sweep synchronously. Returns the count of unlinked files. */
  sweepOnce(): { unlinked: number } {
    const dir = this.cfg.stateDir.attachmentDir;
    const ttlMs = this.cfg.ttlHours * 3600 * 1000;
    const now = this.cfg.clock.now();
    let unlinked = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return { unlinked: 0 };
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // mtime in ms; add fallback for filesystems with second-precision
      const mtimeMs = stat.mtimeMs;
      if (now - mtimeMs > ttlMs) {
        try {
          fs.unlinkSync(p);
          unlinked += 1;
        } catch {
          /* skip */
        }
      }
    }
    if (unlinked > 0) {
      this.cfg.eventBus.emit("log_emit", {
        level: "INFO",
        event_type: "attachment_janitor",
        fields: { unlinked, dir },
      });
    }
    return { unlinked };
  }
}
