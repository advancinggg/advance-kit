import type { Clock } from "../daemon/clock";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Per-chat token bucket for "no active session" replies. Prevents flooding the
 * admin chat with no-session replies when the admin sends many DMs while no
 * sessions are registered.
 *
 * Independence: `/list` (handled separately) is NOT subject to this throttle
 * (PRD §4.6 explicit invariant — verified by AC-16).
 */
export class NoSessionReplyThrottle {
  private lastConsumed = new Map<number | string, number>();
  private intervalMs: number;
  private clock: Clock;

  constructor(clock: Clock, intervalMs?: number) {
    this.clock = clock;
    this.intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Try to consume a token for the given chat_id. Returns true if reply allowed,
   * false if throttled.
   */
  tryReply(chat_id: number | string): boolean {
    const now = this.clock.now();
    const last = this.lastConsumed.get(chat_id);
    if (last !== undefined && now - last < this.intervalMs) {
      return false;
    }
    this.lastConsumed.set(chat_id, now);
    return true;
  }

  clearForTest(): void {
    this.lastConsumed.clear();
  }
}
