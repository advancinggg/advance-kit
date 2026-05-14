import { describe, expect, test } from "bun:test";
import { fakeClock } from "../../src/daemon/clock";
import { NoSessionReplyThrottle } from "../../src/routing/no-session-throttle";

describe("MODULE-005-AC-15: NoSessionReplyThrottle", () => {
  test("MODULE-005-T15 — per-chat 1 reply per 5min; subsequent attempts in window silently dropped", () => {
    const clock = fakeClock(0);
    const t = new NoSessionReplyThrottle(clock, 5 * 60_000);
    expect(t.tryReply(1)).toBe(true); // first allowed
    for (let i = 0; i < 4; i++) {
      expect(t.tryReply(1)).toBe(false); // throttled
    }
    clock.tick(5 * 60_000); // now 5min has elapsed
    expect(t.tryReply(1)).toBe(true); // refilled
  });

  test("MODULE-005-T15b — per-chat keyed (chat A throttled, chat B independent)", () => {
    const clock = fakeClock(0);
    const t = new NoSessionReplyThrottle(clock, 5 * 60_000);
    expect(t.tryReply(1)).toBe(true);
    expect(t.tryReply(2)).toBe(true); // different chat — own bucket
    expect(t.tryReply(1)).toBe(false); // chat 1 still throttled
    expect(t.tryReply(2)).toBe(false); // chat 2 also throttled
  });
});
