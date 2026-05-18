import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { TelegramAPIClient } from "./client";

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface ChatTypeCache {
  /** Cache hit returns cached value; miss invokes lazy-fetch via CONTRACT-004 getChat. */
  getChatType(chat_id: number): Promise<ChatType>;
  /** Side-effect write used by inbound flow (M005) to warm the cache from chat.type already in the update payload. No event emitted. */
  primeCache(chat_id: number, type: ChatType): void;
}

export interface ChatTypeCacheConfig {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_ENTRIES = 1000;

interface CacheEntry {
  type: ChatType;
  insertedAt: number;
}

export class ChatTypeFetchError extends Error {
  constructor(
    public readonly chat_id: number,
    public readonly underlying: unknown,
  ) {
    super(`getChat(${chat_id}) failed`);
    this.name = "ChatTypeFetchError";
  }
}

export class ChatTypeCacheImpl implements ChatTypeCache {
  private readonly cache: Map<number, CacheEntry> = new Map();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly apiClient: TelegramAPIClient,
    private readonly clock: Clock,
    private readonly eventBus: EventBus,
    cfg: ChatTypeCacheConfig = {},
  ) {
    this.ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = cfg.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async getChatType(chat_id: number): Promise<ChatType> {
    const existing = this.cache.get(chat_id);
    if (existing && this.clock.now() - existing.insertedAt < this.ttlMs) {
      // Hit. Move to most-recent position; refresh insertedAt as the access timestamp.
      this.cache.delete(chat_id);
      this.cache.set(chat_id, { type: existing.type, insertedAt: this.clock.now() });
      this.eventBus.emit("chat_type_lookup", { chat_id, type: existing.type, source: "cache" });
      return existing.type;
    }

    // Miss (absent or TTL-expired). Lazy-fetch via CONTRACT-004.
    let env;
    try {
      env = await this.apiClient.getChat(chat_id);
    } catch (err) {
      // apiClient.getChat already wraps its own fetch errors into the envelope,
      // so this catch is defensive — treat as a fetch failure.
      this.eventBus.emit("chat_type_lookup", { chat_id, source: "lazy_fetch_getChat", failed: true });
      throw new ChatTypeFetchError(chat_id, err);
    }

    if (!env.ok) {
      this.eventBus.emit("chat_type_lookup", { chat_id, source: "lazy_fetch_getChat", failed: true });
      throw new ChatTypeFetchError(chat_id, env.error);
    }

    const type = env.result.type;
    this.storeEntry(chat_id, type);
    this.eventBus.emit("chat_type_lookup", { chat_id, type, source: "lazy_fetch_getChat" });
    return type;
  }

  primeCache(chat_id: number, type: ChatType): void {
    this.storeEntry(chat_id, type);
  }

  /** Test-visible: current cache size. */
  size(): number {
    return this.cache.size;
  }

  private storeEntry(chat_id: number, type: ChatType): void {
    // delete + set ensures the entry sits at the most-recent insertion position
    // (Map iteration order == insertion order; this is the LRU mechanism).
    this.cache.delete(chat_id);
    this.cache.set(chat_id, { type, insertedAt: this.clock.now() });
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }
}
