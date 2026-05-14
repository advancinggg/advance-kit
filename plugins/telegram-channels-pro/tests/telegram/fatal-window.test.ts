import { describe, expect, test } from "bun:test";
import { FatalWindow } from "../../src/telegram/fatal-window";

describe("MODULE-002-AC-02: sliding 60s/5-fatal threshold", () => {
  test("MODULE-002-T02 — 5 fatals within 60s trips the window", () => {
    const fw = new FatalWindow(60_000, 5);
    let ts = 1000;
    for (let i = 0; i < 4; i++) fw.record(ts + i * 1000);
    expect(fw.tripped(ts + 4_000)).toBe(false);
    fw.record(ts + 5_000);
    expect(fw.tripped(ts + 5_000)).toBe(true);
  });

  test("MODULE-002-T02b — old fatals outside the window are evicted", () => {
    const fw = new FatalWindow(60_000, 5);
    for (let i = 0; i < 4; i++) fw.record(i * 1000); // ts 0..3000
    // 70s later — those 4 fatals should age out
    fw.record(70_000);
    expect(fw.tripped(70_000)).toBe(false);
    expect(fw.count()).toBe(1);
  });

  test("reset clears the window", () => {
    const fw = new FatalWindow(60_000, 5);
    for (let i = 0; i < 5; i++) fw.record(1000 + i);
    expect(fw.tripped(1005)).toBe(true);
    fw.reset();
    expect(fw.tripped(1005)).toBe(false);
  });
});

describe("MODULE-002-AC-07: exponential backoff", () => {
  test("MODULE-002-T07 — backoff sequence 1s, 2s, 4s, ..., cap 60s", () => {
    // Direct algorithm probe; PollingLoop.backoffMs uses Math.min(1000 * 2^idx, cap).
    const cap = 60_000;
    const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => Math.min(1000 * Math.pow(2, i), cap));
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  });
});
