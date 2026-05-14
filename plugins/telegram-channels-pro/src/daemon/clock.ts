export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  setInterval(fn: () => void, ms: number): TimerHandle;
}

export function realClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(h) };
    },
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      return { cancel: () => clearInterval(h) };
    },
  };
}

interface FakeTimer {
  id: number;
  fireAt: number;
  intervalMs: number | null;
  fn: () => void;
  cancelled: boolean;
}

export interface FakeClock extends Clock {
  tick(ms: number): void;
  pendingTimers(): number;
  reset(): void;
}

export function fakeClock(startTs = 0): FakeClock {
  let currentTs = startTs;
  const timers: FakeTimer[] = [];
  let nextId = 1;

  function schedule(fn: () => void, ms: number, intervalMs: number | null): TimerHandle {
    const id = nextId++;
    const timer: FakeTimer = {
      id,
      fireAt: currentTs + Math.max(0, ms),
      intervalMs,
      fn,
      cancelled: false,
    };
    timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  return {
    now: () => currentTs,
    setTimeout(fn, ms) {
      return schedule(fn, ms, null);
    },
    setInterval(fn, ms) {
      return schedule(fn, ms, ms);
    },
    tick(deltaMs: number) {
      if (deltaMs < 0) throw new Error("FakeClock.tick: deltaMs must be non-negative");
      const targetTs = currentTs + deltaMs;
      while (true) {
        // Find the earliest non-cancelled timer that is due.
        let dueIdx = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (let i = 0; i < timers.length; i++) {
          const t = timers[i]!;
          if (t.cancelled) continue;
          if (t.fireAt <= targetTs && t.fireAt < dueAt) {
            dueIdx = i;
            dueAt = t.fireAt;
          }
        }
        if (dueIdx === -1) break;
        const t = timers[dueIdx]!;
        currentTs = t.fireAt;
        if (t.intervalMs !== null) {
          t.fireAt = currentTs + t.intervalMs;
        } else {
          t.cancelled = true;
        }
        try {
          t.fn();
        } catch (err) {
          // Swallow errors; tests should explicitly assert on behavior.
          // eslint-disable-next-line no-console
          console.error("FakeClock timer error:", err);
        }
      }
      currentTs = targetTs;
      // Purge cancelled timers periodically.
      for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.cancelled) timers.splice(i, 1);
    },
    pendingTimers() {
      return timers.filter((t) => !t.cancelled).length;
    },
    reset() {
      currentTs = startTs;
      timers.length = 0;
      nextId = 1;
    },
  };
}
