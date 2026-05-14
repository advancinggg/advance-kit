import { spawnSync } from "node:child_process";
import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";

export interface MeasurementSample {
  ts: number;
  rss_kb: number;
  cpu_pct: number;
}

export interface MeasurementHelperConfig {
  eventBus: EventBus;
  clock: Clock;
  daemonPid: number;
  /** "Stationary" idle threshold in ms (no tool_call within this window). Default 60s. */
  quietWindowMs?: number;
  /** Sample cadence; default 30s. */
  sampleCadenceMs?: number;
  /** Override ps spawn for tests. */
  sampleFn?: (pid: number) => MeasurementSample | null;
}

export class MeasurementHelper {
  private cfg: Required<MeasurementHelperConfig>;
  private lastToolCallTs = 0;
  private currentPending = 0;
  private samples: MeasurementSample[] = [];
  private timer: TimerHandle | null = null;
  private unsubscribes: Array<() => void> = [];

  constructor(cfg: MeasurementHelperConfig) {
    this.cfg = {
      quietWindowMs: 60_000,
      sampleCadenceMs: 30_000,
      sampleFn: defaultSampleViaPs,
      ...cfg,
    };
  }

  start(): void {
    this.unsubscribes.push(
      this.cfg.eventBus.on("tool_call", () => {
        this.lastToolCallTs = this.cfg.clock.now();
      }),
      this.cfg.eventBus.on("pending_capacity_snapshot", (p) => {
        this.currentPending = p.current;
      }),
      this.cfg.eventBus.on("daemon_stop", () => this.stop()),
    );
    this.timer = this.cfg.clock.setInterval(() => this.tick(), this.cfg.sampleCadenceMs);
  }

  stop(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }

  /** Test-visible: manually invoke one sampling tick. */
  tick(): void {
    const now = this.cfg.clock.now();
    const idleMs = now - this.lastToolCallTs;
    if (idleMs < this.cfg.quietWindowMs || this.currentPending > 0) return; // not stationary
    const sample = this.cfg.sampleFn(this.cfg.daemonPid);
    if (!sample) return;
    this.samples.push(sample);
    this.cfg.eventBus.emit("log_emit", {
      level: "DEBUG",
      event_type: "stationary_sample",
      fields: { rss_kb: sample.rss_kb, cpu_pct: sample.cpu_pct, ts: sample.ts },
    });
  }

  /** Test-visible: read collected samples. */
  getSamples(): MeasurementSample[] {
    return this.samples.slice();
  }
}

function defaultSampleViaPs(pid: number): MeasurementSample | null {
  const res = spawnSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return null;
  const parts = res.stdout.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const rss = parseInt(parts[0]!, 10);
  const cpu = parseFloat(parts[1]!);
  if (!Number.isFinite(rss) || !Number.isFinite(cpu)) return null;
  return { ts: Date.now(), rss_kb: rss, cpu_pct: cpu };
}
