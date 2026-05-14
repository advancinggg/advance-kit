import type { Clock, TimerHandle } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { SendMessageEnvelope, TelegramAPIClient } from "../telegram/client";
import type { JsonLogger } from "./json-logger";

export type AlertCategory = "edge_triggered" | "one_shot" | "token_bucket" | "crash_restart_merge";

export interface AlertEntry {
  topic: string;
  severity: "warn" | "failure";
  detail?: unknown;
  enqueuedAt: number;
  category: AlertCategory;
}

const TOKEN_BUCKET_REFILL_MS = 10 * 60_000;
const CRASH_MERGE_WINDOW_MS = 5 * 60_000;
const ALERT_QUEUE_SOFT_CAP = 50;
const ADMIN_CHAT_PLACEHOLDER = 0; // Replaced with allowlist primary admin once known.

export interface AlertDispatcherConfig {
  eventBus: EventBus;
  clock: Clock;
  logger: JsonLogger;
  tokenBucketRefillMs?: number;
  crashMergeWindowMs?: number;
}

export class AlertDispatcher {
  private cfg: Required<AlertDispatcherConfig>;
  private tgClient: TelegramAPIClient | null = null;
  private adminChatId: number | null = null;
  private quarantineState: "running" | "quarantine" = "running";
  private oneShotFired = new Set<string>();
  private tokenBucket = new Map<string, number>(); // key → last-fire ts
  private crashRestartTimestamps: number[] = [];
  private crashMergeTimer: TimerHandle | null = null;
  private pendingQueue: AlertEntry[] = [];

  constructor(cfg: AlertDispatcherConfig) {
    this.cfg = {
      tokenBucketRefillMs: TOKEN_BUCKET_REFILL_MS,
      crashMergeWindowMs: CRASH_MERGE_WINDOW_MS,
      ...cfg,
    };
  }

  setTgClient(tg: TelegramAPIClient, adminChatId: number): void {
    this.tgClient = tg;
    this.adminChatId = adminChatId;
    // Flush any queued alerts.
    void this.flushQueue();
  }

  feedEvent(eventType: string, payload: unknown): void {
    if (eventType === "quarantine_enter") this.handleQuarantine("enter");
    else if (eventType === "quarantine_exit") this.handleQuarantine("exit");
    else if (eventType === "watchdog_signal") {
      const p = payload as { severity?: string; kind?: string; detail?: unknown };
      if (p.severity === "failure") this.handleOneShot(`watchdog:${p.kind}`, p);
    } else if (eventType === "alert_emit") {
      const p = payload as { severity: "warn" | "failure"; topic: string; detail?: unknown };
      this.handleAlertEmit(p);
    } else if (eventType === "auth_deny_routing" || eventType === "auth_deny_registration") {
      const p = payload as { sender_hash?: string; kind?: string };
      const bucketKey = `${eventType}:${p.sender_hash ?? p.kind ?? "global"}`;
      this.handleTokenBucket(bucketKey, eventType, p);
    } else if (eventType === "daemon_start") {
      this.handleDaemonStart();
    }
  }

  private handleQuarantine(transition: "enter" | "exit"): void {
    const next = transition === "enter" ? "quarantine" : "running";
    if (this.quarantineState === next) return;
    this.quarantineState = next;
    this.enqueue({
      topic: `quarantine_${transition}`,
      severity: "warn",
      enqueuedAt: this.cfg.clock.now(),
      category: "edge_triggered",
    });
  }

  private handleOneShot(key: string, payload: unknown): void {
    if (this.oneShotFired.has(key)) return;
    this.oneShotFired.add(key);
    this.enqueue({
      topic: key,
      severity: "failure",
      detail: payload,
      enqueuedAt: this.cfg.clock.now(),
      category: "one_shot",
    });
  }

  private handleTokenBucket(key: string, eventType: string, payload: unknown): void {
    const last = this.tokenBucket.get(key);
    const now = this.cfg.clock.now();
    if (last !== undefined && now - last < this.cfg.tokenBucketRefillMs) return; // bucket empty
    this.tokenBucket.set(key, now);
    this.enqueue({
      topic: eventType,
      severity: "warn",
      detail: payload,
      enqueuedAt: now,
      category: "token_bucket",
    });
  }

  private handleAlertEmit(p: { severity: "warn" | "failure"; topic: string; detail?: unknown }): void {
    // alert_emit events with topic 'watchdog' are already handled via watchdog_signal.
    if (p.topic === "watchdog") return;
    this.enqueue({
      topic: p.topic,
      severity: p.severity,
      detail: p.detail,
      enqueuedAt: this.cfg.clock.now(),
      category: "edge_triggered",
    });
  }

  private handleDaemonStart(): void {
    const now = this.cfg.clock.now();
    this.crashRestartTimestamps.push(now);
    // Evict entries older than the merge window.
    const cutoff = now - this.cfg.crashMergeWindowMs;
    this.crashRestartTimestamps = this.crashRestartTimestamps.filter((t) => t >= cutoff);
    if (this.crashMergeTimer) this.crashMergeTimer.cancel();
    this.crashMergeTimer = this.cfg.clock.setTimeout(() => this.flushCrashMerge(), this.cfg.crashMergeWindowMs);
  }

  private flushCrashMerge(): void {
    const count = this.crashRestartTimestamps.length;
    if (count >= 2) {
      this.enqueue({
        topic: "daemon_crash_restart_merged",
        severity: "warn",
        detail: { count, window_ms: this.cfg.crashMergeWindowMs },
        enqueuedAt: this.cfg.clock.now(),
        category: "crash_restart_merge",
      });
    }
    this.crashRestartTimestamps = [];
    this.crashMergeTimer = null;
  }

  private enqueue(entry: AlertEntry): void {
    if (this.pendingQueue.length >= ALERT_QUEUE_SOFT_CAP) {
      // Drop oldest with self-warn.
      this.pendingQueue.shift();
      this.cfg.eventBus.emit("subscriber_queue_drop", {
        subscriber_id: "alert-dispatcher",
        event_type: "alert_emit",
        drop_count: 1,
      });
    }
    this.pendingQueue.push(entry);
    if (this.tgClient && this.adminChatId !== null) void this.flushQueue();
  }

  private async flushQueue(): Promise<void> {
    if (!this.tgClient || this.adminChatId === null) return;
    while (this.pendingQueue.length > 0) {
      const entry = this.pendingQueue.shift()!;
      const text = `[${entry.severity.toUpperCase()}] ${entry.topic}` + (entry.detail ? `\n${JSON.stringify(entry.detail)}` : "");
      try {
        const env: SendMessageEnvelope = await this.tgClient.sendMessage({ chat_id: this.adminChatId, text });
        if (!env.delivered) {
          this.cfg.logger.append({
            ts: this.cfg.clock.now(),
            level: "WARN",
            event_type: "alert_delivery_failed",
            topic: entry.topic,
            severity: entry.severity,
            envelope: env,
          });
        }
      } catch (err) {
        this.cfg.logger.append({
          ts: this.cfg.clock.now(),
          level: "WARN",
          event_type: "alert_delivery_failed",
          topic: entry.topic,
          severity: entry.severity,
          error: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  /** Emergency exit-path: drain queued alerts to log only with delivery='aborted'. */
  drainAlertsToLogOnly(): number {
    let drained = 0;
    while (this.pendingQueue.length > 0) {
      const entry = this.pendingQueue.shift()!;
      this.cfg.logger.append({
        ts: this.cfg.clock.now(),
        level: "WARN",
        event_type: "alert_emit",
        topic: entry.topic,
        severity: entry.severity,
        detail: entry.detail,
        delivery: "aborted",
        category: entry.category,
      });
      drained += 1;
    }
    return drained;
  }

  /** Test-visible queue depth. */
  pendingCount(): number {
    return this.pendingQueue.length;
  }
}

export { ADMIN_CHAT_PLACEHOLDER };
