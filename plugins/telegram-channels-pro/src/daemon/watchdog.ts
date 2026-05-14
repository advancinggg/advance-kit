import type { Clock, TimerHandle } from "./clock";
import type { DeploymentMode } from "./deployment-mode";
import type { EventBus } from "./event-bus";
import type { WatchdogKind, WatchdogSeverity } from "./event-types";

export interface WatchdogConfig {
  eventBus: EventBus;
  clock: Clock;
  deploymentMode: DeploymentMode;
  bootPpid: number;
  getCurrentPpid: () => number;
  requestShutdown: (reason: string) => void | Promise<void>;
  probeIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  idleTtlMs?: number;
}

export class Watchdog {
  private cfg: Required<WatchdogConfig>;
  private intervalHandle: TimerHandle | null = null;
  private unsubscribes: Array<() => void> = [];
  private lastPollingHealthTs: number;
  private mcpClientCount = 0;
  private lastClientDisconnectTs: number;
  private signalled = false;

  constructor(cfg: WatchdogConfig) {
    this.cfg = {
      probeIntervalMs: 1000,
      heartbeatTimeoutMs: 60_000,
      idleTtlMs: 30 * 60_000,
      ...cfg,
    };
    // Initialize heartbeat to now: gives M002 a full window to start polling
    // without the watchdog tripping stuck-detection during boot.
    this.lastPollingHealthTs = this.cfg.clock.now();
    this.lastClientDisconnectTs = this.cfg.clock.now();
  }

  start(): void {
    const eb = this.cfg.eventBus;
    this.unsubscribes.push(
      eb.on("polling_health", () => {
        this.lastPollingHealthTs = this.cfg.clock.now();
      }),
      eb.on("session_connected", () => {
        this.mcpClientCount += 1;
      }),
      eb.on("session_disconnected", () => {
        this.mcpClientCount = Math.max(0, this.mcpClientCount - 1);
        this.lastClientDisconnectTs = this.cfg.clock.now();
      }),
    );
    this.intervalHandle = this.cfg.clock.setInterval(() => this.probeOnce(), this.cfg.probeIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      this.intervalHandle.cancel();
      this.intervalHandle = null;
    }
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }

  /** Exposed for tests: invokes one probe iteration synchronously. */
  probeOnce(): void {
    if (this.signalled) return;
    const now = this.cfg.clock.now();
    const currentPpid = this.cfg.getCurrentPpid();
    // Orphan: parent process disappeared (currentPpid != bootPpid AND bootPpid != 1).
    if (currentPpid !== this.cfg.bootPpid && this.cfg.bootPpid !== 1) {
      this.signal("orphan", "failure", { bootPpid: this.cfg.bootPpid, currentPpid });
      return;
    }
    // Stuck: no polling_health for > heartbeatTimeout.
    const heartbeatAge = now - this.lastPollingHealthTs;
    if (heartbeatAge > this.cfg.heartbeatTimeoutMs) {
      this.signal("stuck", "failure", { heartbeat_age_ms: heartbeatAge });
      return;
    }
    // Idle (lazy-spawn only): zero clients and beyond idle TTL.
    if (this.cfg.deploymentMode === "lazy-spawn" && this.mcpClientCount === 0) {
      const idleMs = now - this.lastClientDisconnectTs;
      if (idleMs > this.cfg.idleTtlMs) {
        this.signal("idle", "normal", { client_count: 0, idle_duration_ms: idleMs });
        return;
      }
    }
  }

  private signal(kind: WatchdogKind, severity: WatchdogSeverity, detail: Record<string, unknown>): void {
    this.signalled = true;
    if (severity === "failure") {
      this.cfg.eventBus.emit("alert_emit", {
        severity: "failure",
        topic: "watchdog",
        detail: { kind, ...detail },
      });
    }
    this.cfg.eventBus.emit("watchdog_signal", { kind, severity, detail });
    if (this.intervalHandle) {
      this.intervalHandle.cancel();
      this.intervalHandle = null;
    }
    void this.cfg.requestShutdown(`watchdog:${kind}`);
  }
}
