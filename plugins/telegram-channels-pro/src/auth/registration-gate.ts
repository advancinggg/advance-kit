import type { Clock, TimerHandle } from "../daemon/clock";
import type { DeploymentMode } from "../daemon/deployment-mode";
import type { EventBus } from "../daemon/event-bus";
import { shortHash } from "../common/hash";
import { generateRegistrationCode, REGISTRATION_CODE_REGEX } from "./code-gen";
import type { AdminAllowlistImpl } from "./allowlist";
import { writeAdminFile } from "./admin-file";
import type { StateDir } from "../daemon/state-dir";

export type RegistrationResult =
  | { kind: "success"; admin_user_id: number }
  | { kind: "fail_format" }
  | { kind: "fail_code" }
  | { kind: "rate_limited_per_sender" }
  | { kind: "rate_limited_global" }
  | { kind: "not_registration_dm" };

export type RegistrationState = "closed" | "open" | "waiting_for_reset";

export interface RegistrationGate {
  isInRegistrationWindow(): boolean;
  processRegistrationDM(senderUserId: number, text: string): Promise<RegistrationResult> | RegistrationResult;
  state(): RegistrationState;
  /** Test-visible: returns the active code if window is open (otherwise null). */
  currentCodeForTest(): string | null;
  /** Test-visible: force the 5-min timeout to fire. */
  forceTimeoutForTest(): void;
  /**
   * Slice 2: in-process re-open from any prior state for M007 reset-admin recovery.
   * Cancels both pending timers (window-timeout + waitForResetReminder), resets brute-force
   * counters, transitions state to 'open', emits registration_event{window_opened, detail:{code_hash, trigger:'admin_reset'}}.
   */
  forceReopenForReset(): void;
  /** Stop timer (e.g., on daemon_stop). */
  stop(): void;
}

export interface RegistrationGateConfig {
  stateDir: StateDir;
  allowlist: AdminAllowlistImpl;
  clock: Clock;
  eventBus: EventBus;
  deploymentMode: DeploymentMode;
  windowMs?: number;
  perSenderLimit?: number;
  globalLimit?: number;
  /** Callback for surfacing the code via stderr / MCP session log. */
  emitCodeToStderr?: (code: string) => void;
}

export class RegistrationGateImpl implements RegistrationGate {
  private cfg: Required<RegistrationGateConfig>;
  private currentState: RegistrationState = "closed";
  private currentCode: string | null = null;
  private timer: TimerHandle | null = null;
  private waitForResetReminderTimer: TimerHandle | null = null;
  private perSenderCount = new Map<number, number>();
  private globalCount = 0;

  constructor(cfg: RegistrationGateConfig) {
    this.cfg = {
      windowMs: 5 * 60_000,
      perSenderLimit: 5,
      globalLimit: 30,
      emitCodeToStderr: (code) => process.stderr.write(`Registration code: ${code}\nSend \`register ${code}\` to bot within 5 minutes to claim admin.\n`),
      ...cfg,
    };
  }

  openWindow(trigger?: string): void {
    if (this.currentState !== "closed") return;
    const code = generateRegistrationCode();
    this.currentCode = code;
    this.currentState = "open";
    this.perSenderCount.clear();
    this.globalCount = 0;
    this.cfg.emitCodeToStderr(code);
    const detail: Record<string, unknown> = { code_hash: shortHash(code) };
    if (trigger) detail.trigger = trigger;
    this.cfg.eventBus.emit("registration_event", {
      kind: "window_opened",
      detail,
    });
    this.timer = this.cfg.clock.setTimeout(() => this.handleTimeout(), this.cfg.windowMs);
  }

  forceReopenForReset(): void {
    // Cancel any pending registration-window timeout timer
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    // Cancel waiting_for_reset reminder timer (if active)
    if (this.waitForResetReminderTimer) {
      this.waitForResetReminderTimer.cancel();
      this.waitForResetReminderTimer = null;
    }
    // Force closed state regardless of prior state, then re-open via the standard path
    this.currentState = "closed";
    this.currentCode = null;
    this.openWindow("admin_reset");
  }

  private handleTimeout(): void {
    if (this.currentState !== "open") return;
    if (this.cfg.deploymentMode === "lazy-spawn") {
      this.cfg.eventBus.emit("registration_event", { kind: "timeout_lazy_spawn" });
      this.currentState = "closed";
      this.currentCode = null;
      // Caller (main.ts via shutdownCtl) is expected to exit; here we just mark state.
    } else {
      this.cfg.eventBus.emit("registration_event", { kind: "timeout_launchd" });
      this.cfg.eventBus.emit("registration_timeout", { ts: this.cfg.clock.now() });
      this.cfg.eventBus.emit("registration_event", { kind: "waiting_for_reset" });
      this.currentState = "waiting_for_reset";
      this.currentCode = null;
      // MODULE-006 §1.4.4 step 3: stderr periodic hint every 5min while waiting_for_reset.
      this.scheduleWaitForResetReminder();
    }
  }

  private scheduleWaitForResetReminder(): void {
    if (this.waitForResetReminderTimer) return;
    const fire = (): void => {
      if (this.currentState !== "waiting_for_reset") {
        this.waitForResetReminderTimer = null;
        return;
      }
      process.stderr.write(
        "telegram-channels-pro: registration timed out; run `reset-admin` to retry\n",
      );
      this.waitForResetReminderTimer = this.cfg.clock.setTimeout(fire, 5 * 60_000);
    };
    this.waitForResetReminderTimer = this.cfg.clock.setTimeout(fire, 5 * 60_000);
  }

  forceTimeoutForTest(): void {
    this.handleTimeout();
  }

  state(): RegistrationState {
    return this.currentState;
  }

  isInRegistrationWindow(): boolean {
    return this.currentState === "open";
  }

  currentCodeForTest(): string | null {
    return this.currentCode;
  }

  async processRegistrationDM(senderUserId: number, text: string): Promise<RegistrationResult> {
    if (this.currentState !== "open") {
      return { kind: "not_registration_dm" };
    }
    // Per-sender check first (silently rate-limit without emitting events to avoid noise).
    const senderFails = this.perSenderCount.get(senderUserId) ?? 0;
    if (senderFails >= this.cfg.perSenderLimit) {
      return { kind: "rate_limited_per_sender" };
    }
    if (this.globalCount >= this.cfg.globalLimit) {
      this.tripGlobal();
      return { kind: "rate_limited_global" };
    }
    const match = /^register (.+)$/.exec(text);
    if (!match) {
      this.incFails(senderUserId);
      return { kind: "fail_format" };
    }
    const candidate = match[1]!;
    if (!REGISTRATION_CODE_REGEX.test(candidate)) {
      this.incFails(senderUserId);
      return { kind: "fail_format" };
    }
    if (candidate !== this.currentCode) {
      this.incFails(senderUserId);
      return { kind: "fail_code" };
    }
    // success
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    this.currentState = "closed";
    const sentinel = this.currentCode;
    this.currentCode = null;
    void sentinel; // intentionally drop
    this.cfg.allowlist.setFromFile(senderUserId);
    await writeAdminFile(this.cfg.stateDir, senderUserId);
    this.cfg.eventBus.emit("registration_event", {
      kind: "admin_registered",
      detail: { admin_user_id_hash: shortHash(String(senderUserId)) },
    });
    return { kind: "success", admin_user_id: senderUserId };
  }

  private incFails(senderUserId: number): void {
    const cur = this.perSenderCount.get(senderUserId) ?? 0;
    const next = cur + 1;
    this.perSenderCount.set(senderUserId, next);
    this.globalCount += 1;
    if (next >= this.cfg.perSenderLimit || this.globalCount >= this.cfg.globalLimit) {
      this.cfg.eventBus.emit("auth_deny_registration", {
        kind: next >= this.cfg.perSenderLimit ? "per_sender" : "global_trip",
        sender_hash: shortHash(String(senderUserId)),
      });
    }
    if (this.globalCount >= this.cfg.globalLimit) {
      this.tripGlobal();
    }
  }

  private tripGlobal(): void {
    if (this.currentState === "waiting_for_reset") return;
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    this.currentState = "waiting_for_reset";
    this.currentCode = null;
    this.cfg.eventBus.emit("registration_event", { kind: "window_closed_brute_force" });
    // MODULE-006 §1.4.3: in launchd mode global-trip also emits waiting_for_reset.
    this.cfg.eventBus.emit("registration_event", { kind: "waiting_for_reset" });
  }

  stop(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    if (this.waitForResetReminderTimer) {
      this.waitForResetReminderTimer.cancel();
      this.waitForResetReminderTimer = null;
    }
  }
}
