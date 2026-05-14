import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import { FatalWindow } from "./fatal-window";
import type { OffsetManager } from "./offset-manager";
import type { PollingStatusImpl } from "./polling-status";
import type { TelegramAPIClient } from "./client";
import type { TelegramUpdate } from "./methods";

export interface PollingLoopConfig {
  tgClient: TelegramAPIClient;
  eventBus: EventBus;
  offsetManager: OffsetManager;
  pollingStatus: PollingStatusImpl;
  clock: Clock;
  longPollTimeoutSec?: number;
  fatalWindowMs?: number;
  fatalThreshold?: number;
  quarantineCooldownMs?: number;
  backoffCapMs?: number;
}

export class PollingLoop {
  private cfg: Required<PollingLoopConfig>;
  private fatalWindow: FatalWindow;
  private running = false;
  private stopRequested = false;
  private state: "running" | "quarantine" | "paused" = "running";
  private quarantineEnteredAt = 0;
  private backoffIdx = 0;
  private unsubscribes: Array<() => void> = [];
  private loopPromise: Promise<void> | null = null;

  constructor(cfg: PollingLoopConfig) {
    this.cfg = {
      longPollTimeoutSec: 25,
      fatalWindowMs: 60_000,
      fatalThreshold: 5,
      quarantineCooldownMs: 60_000,
      backoffCapMs: 60_000,
      ...cfg,
    };
    this.fatalWindow = new FatalWindow(this.cfg.fatalWindowMs, this.cfg.fatalThreshold);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribes.push(
      this.cfg.eventBus.on("registration_timeout", () => {
        this.state = "paused";
        this.cfg.pollingStatus.setState("paused");
        this.cfg.eventBus.emit("alert_emit", {
          severity: "warn",
          topic: "polling_paused_registration_timeout",
        });
      }),
      this.cfg.eventBus.on("daemon_stop", () => {
        this.stopRequested = true;
      }),
    );
    this.loopPromise = this.loop();
  }

  stop(): void {
    this.stopRequested = true;
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }

  /** Test-visible: stop + await the loop promise to fully exit. */
  async stopAndWait(): Promise<void> {
    this.stop();
    if (this.loopPromise) await this.loopPromise;
  }

  private backoffMs(idx: number): number {
    return Math.min(1000 * Math.pow(2, idx), this.cfg.backoffCapMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => this.cfg.clock.setTimeout(res, ms));
  }

  private emitHeartbeat(): void {
    this.cfg.eventBus.emit("polling_health", { ts: this.cfg.clock.now(), state: this.state });
  }

  private async processUpdates(updates: TelegramUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    let maxUpdateId = this.cfg.offsetManager.current() - 1;
    for (const u of updates) {
      if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
    }
    // Persist offset BEFORE publishing inbound_update events (AC-08).
    const newOffset = maxUpdateId + 1;
    await this.cfg.offsetManager.persist(newOffset);
    this.cfg.pollingStatus.setOffset(newOffset);
    for (const u of updates) {
      const type: "message" | "callback_query" = u.message ? "message" : u.callback_query ? "callback_query" : "message";
      this.cfg.eventBus.emit("inbound_update", { update_id: u.update_id, type, payload: u });
      this.cfg.pollingStatus.noteInbound(this.cfg.clock.now());
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      if (this.state === "paused") {
        await this.sleep(1000);
        continue;
      }
      if (this.state === "quarantine") {
        await this.sleep(this.cfg.quarantineCooldownMs);
        if (this.stopRequested) break;
        const probe = await this.cfg.tgClient.getUpdates({
          offset: this.cfg.offsetManager.current(),
          timeout: 5,
        });
        if (probe.ok && probe.classified.kind === "ok") {
          const recoveredAfterMs = this.cfg.clock.now() - this.quarantineEnteredAt;
          this.cfg.eventBus.emit("quarantine_exit", { recovered_after_ms: recoveredAfterMs });
          this.cfg.eventBus.emit("alert_emit", { severity: "warn", topic: "quarantine_exit" });
          this.state = "running";
          this.cfg.pollingStatus.setState("running");
          this.fatalWindow.reset();
          this.backoffIdx = 0;
          await this.processUpdates(probe.result);
        } else {
          // probe fatal → restart cooldown.
          if (!probe.ok && probe.classified.kind === "fatal") {
            this.fatalWindow.record(this.cfg.clock.now());
          }
        }
        continue;
      }
      // running state
      const res = await this.cfg.tgClient.getUpdates({
        offset: this.cfg.offsetManager.current(),
        timeout: this.cfg.longPollTimeoutSec,
      });
      if (res.ok && res.classified.kind === "ok") {
        this.emitHeartbeat();
        await this.processUpdates(res.result);
        this.backoffIdx = 0;
        this.fatalWindow.reset();
        this.cfg.pollingStatus.setFatalWindowCount(0);
        continue;
      }
      // error path
      const classified = res.classified;
      if (classified.kind === "conflict_409") {
        this.cfg.eventBus.emit("polling_event", { kind: "conflict_409" });
        await this.sleep(this.backoffMs(this.backoffIdx++));
        continue;
      }
      if (classified.kind === "rate_limited_429") {
        this.cfg.eventBus.emit("polling_event", {
          kind: "rate_limited_429",
          detail: { retry_after_sec: classified.retryAfterSec },
        });
        await this.sleep(classified.retryAfterSec * 1000);
        continue;
      }
      // fatal
      this.fatalWindow.record(this.cfg.clock.now());
      this.cfg.pollingStatus.setFatalWindowCount(this.fatalWindow.count());
      if (this.fatalWindow.tripped(this.cfg.clock.now())) {
        this.state = "quarantine";
        this.cfg.pollingStatus.setState("quarantine");
        this.quarantineEnteredAt = this.cfg.clock.now();
        this.cfg.eventBus.emit("quarantine_enter", {
          reason: "fatal_window_threshold",
          count_in_window: this.fatalWindow.count(),
          window_ms: this.cfg.fatalWindowMs,
        });
        this.cfg.eventBus.emit("alert_emit", { severity: "warn", topic: "quarantine_enter" });
        this.backoffIdx = 0;
        this.fatalWindow.reset();
      } else {
        await this.sleep(this.backoffMs(this.backoffIdx++));
      }
    }
    this.running = false;
  }
}
