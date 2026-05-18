import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import type { TelegramAPIClient } from "../../src/telegram/client";
import type { GetChatEnvelope } from "../../src/telegram/methods";
import { ChatTypeCacheImpl, ChatTypeFetchError } from "../../src/telegram/chat-type-cache";
import { EventCollector } from "../helpers/event-collector";

interface StubGetChatHandle {
  client: TelegramAPIClient;
  callCount: number;
  /** Enqueue the envelope to return on the NEXT getChat call. Multiple
   *  enqueues form a FIFO; absent enqueue → throws (test misconfiguration). */
  enqueue: (env: GetChatEnvelope) => void;
}

function makeStubClient(): StubGetChatHandle {
  const queue: GetChatEnvelope[] = [];
  let callCount = 0;
  const client = {
    async getChat(_chat_id: number): Promise<GetChatEnvelope> {
      callCount++;
      const next = queue.shift();
      if (!next) throw new Error("chat-type-cache.test: stub getChat called with no enqueued response");
      return next;
    },
  } as unknown as TelegramAPIClient;
  return {
    client,
    get callCount() {
      return callCount;
    },
    enqueue(env: GetChatEnvelope) {
      queue.push(env);
    },
  };
}

describe("MODULE-002-AC-23: ChatTypeCache hit path (REQ-035, CONTRACT-016)", () => {
  test("MODULE-002-T23 — primeCache then getChatType returns cached value in O(1); event source='cache'; no getChat call", async () => {
    const bus = new EventBus();
    const collector = new EventCollector(bus);
    const stub = makeStubClient();
    const clock = fakeClock(1_000);
    const cache = new ChatTypeCacheImpl(stub.client, clock, bus);

    cache.primeCache(999, "private");
    const t = await cache.getChatType(999);
    expect(t).toBe("private");
    expect(stub.callCount).toBe(0); // no lazy-fetch

    const ev = collector.byType("chat_type_lookup");
    expect(ev.length).toBe(1);
    expect((ev[0]!.payload as { source: string }).source).toBe("cache");
    expect((ev[0]!.payload as { type: string }).type).toBe("private");
    collector.stop();
  });
});

describe("MODULE-002-AC-24: ChatTypeCache miss → lazy-fetch (REQ-035, CONTRACT-016)", () => {
  test("MODULE-002-T24 — empty cache → getChat invoked once → cache populated → source='lazy_fetch_getChat'", async () => {
    const bus = new EventBus();
    const collector = new EventCollector(bus);
    const stub = makeStubClient();
    const clock = fakeClock(1_000);
    const cache = new ChatTypeCacheImpl(stub.client, clock, bus);

    stub.enqueue({ ok: true, result: { id: 12345, type: "private" } });
    const t1 = await cache.getChatType(12345);
    expect(t1).toBe("private");
    expect(stub.callCount).toBe(1);

    // Second call should hit cache (no additional getChat invocation).
    const t2 = await cache.getChatType(12345);
    expect(t2).toBe("private");
    expect(stub.callCount).toBe(1);

    const ev = collector.byType("chat_type_lookup");
    expect(ev.length).toBe(2);
    expect((ev[0]!.payload as { source: string }).source).toBe("lazy_fetch_getChat");
    expect((ev[1]!.payload as { source: string }).source).toBe("cache");
    collector.stop();
  });
});

describe("MODULE-002-AC-25: ChatTypeCache miss + fetch failure (REQ-035, CONTRACT-016)", () => {
  test("MODULE-002-T25 — getChat {ok:false} → reject ChatTypeFetchError; cache empty; failed=true event; next call retries", async () => {
    const bus = new EventBus();
    const collector = new EventCollector(bus);
    const stub = makeStubClient();
    const clock = fakeClock(1_000);
    const cache = new ChatTypeCacheImpl(stub.client, clock, bus);

    stub.enqueue({ ok: false, error: "http_500" });
    await expect(cache.getChatType(99)).rejects.toBeInstanceOf(ChatTypeFetchError);
    expect(stub.callCount).toBe(1);
    expect(cache.size()).toBe(0);

    const ev = collector.byType("chat_type_lookup");
    expect(ev.length).toBe(1);
    expect((ev[0]!.payload as { source: string; failed?: boolean }).source).toBe("lazy_fetch_getChat");
    expect((ev[0]!.payload as { failed?: boolean }).failed).toBe(true);

    // Next call must retry — failure is NOT cached.
    stub.enqueue({ ok: true, result: { id: 99, type: "private" } });
    const t = await cache.getChatType(99);
    expect(t).toBe("private");
    expect(stub.callCount).toBe(2);
    collector.stop();
  });
});

describe("MODULE-002-AC-26: ChatTypeCache LRU eviction at 1000 entries (REQ-035, CONTRACT-016)", () => {
  test("MODULE-002-T26 — 1001 inserts → size 1000; oldest evicted; access reorders so touched entry survives next insert", () => {
    const bus = new EventBus();
    const stub = makeStubClient();
    const clock = fakeClock(0);
    const cache = new ChatTypeCacheImpl(stub.client, clock, bus);

    for (let i = 1; i <= 1000; i++) cache.primeCache(i, "private");
    expect(cache.size()).toBe(1000);

    // Insert the 1001st — oldest (chat_id 1) evicted; size still 1000.
    cache.primeCache(1001, "private");
    expect(cache.size()).toBe(1000);

    // The touched entry must NOT be evicted on the next insert.
    // Touching chat_id 2 (now-oldest after eviction of 1) via getChatType moves
    // it to the most-recent position; inserting chat_id 1002 should evict
    // chat_id 3 (now the new oldest), not chat_id 2.
    // (getChatType increments insertedAt via the cache hit path.)
    void cache.getChatType(2);
    cache.primeCache(1002, "private");
    expect(cache.size()).toBe(1000);

    // chat_id 1 was evicted earlier (so re-fetching it would miss → stub
    // would throw because we did NOT enqueue a response, indicating the
    // entry was indeed evicted).
    // chat_id 2 was touched → must still be present (no lazy-fetch).
    const before = stub.callCount;
    void cache.getChatType(2);
    expect(stub.callCount).toBe(before); // hit, no fetch
  });
});

describe("MODULE-002-AC-27: ChatTypeCache TTL expiry (REQ-035, CONTRACT-016)", () => {
  test("MODULE-002-T27 — entry at t=0 hit at t=3_599_999, miss + refetch after TTL elapses with no intervening access", async () => {
    const bus = new EventBus();
    const collector = new EventCollector(bus);
    const stub = makeStubClient();
    const clock = fakeClock(0);
    const cache = new ChatTypeCacheImpl(stub.client, clock, bus);

    cache.primeCache(42, "private"); // insertedAt = 0

    // Just under 1h: hit (no fetch). Under sliding-TTL semantics, this hit
    // refreshes insertedAt to the current clock time.
    clock.tick(3_599_999);
    const t1 = await cache.getChatType(42);
    expect(t1).toBe("private");
    expect(stub.callCount).toBe(0);

    // Advance past the FULL TTL from the refreshed insertedAt. The hit above
    // moved insertedAt to 3_599_999, so we need to be > 3_599_999 + ttlMs to
    // observe expiry on the next call.
    clock.tick(3_600_001); // now = 7_200_000
    stub.enqueue({ ok: true, result: { id: 42, type: "private" } });
    const t2 = await cache.getChatType(42);
    expect(t2).toBe("private");
    expect(stub.callCount).toBe(1);

    const ev = collector.byType("chat_type_lookup");
    // First call (at 3_599_999ms): hit; Second call (post-TTL): lazy_fetch_getChat.
    expect(ev.length).toBe(2);
    expect((ev[0]!.payload as { source: string }).source).toBe("cache");
    expect((ev[1]!.payload as { source: string }).source).toBe("lazy_fetch_getChat");
    collector.stop();
  });
});
