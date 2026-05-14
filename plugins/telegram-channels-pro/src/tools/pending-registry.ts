import type { EventBus } from "../daemon/event-bus";
import type { Clock } from "../daemon/clock";
import type { TelegramAPIClient } from "../telegram/client";

const DEFAULT_CAPACITY = 50;

export interface PendingEntry {
  pending_id: string;
  requester_session_id: string;
  message_id: number;
  chat_id: number;
  callback_data_map: Map<string, string>;
  options: string[];
  created_at: number;
  resolver: (choice: string) => void;
  rejecter: (err: Error) => void;
}

export type PendingEntryAdd = Omit<PendingEntry, "resolver" | "rejecter">;

export interface PendingApprovalRegistry {
  add(
    entry: PendingEntryAdd,
  ):
    | { ok: true; promise: Promise<string> }
    | { ok: false; error: "CapacityExceededError" };
  lookupByPendingId(callback_data: string): PendingEntry | null;
  resolveApproval(
    pending_id: string,
    choice: string,
    callback_query_id: string,
    tg: TelegramAPIClient,
  ): Promise<{ ok: true } | { ok: false; error: "unknown_pending" }>;
  cleanupBySession(
    session_id: string,
    tg: TelegramAPIClient,
  ): Promise<{ cleaned: number }>;
  size(): number;
}

export interface PendingApprovalRegistryConfig {
  eventBus: EventBus;
  clock: Clock;
  capacity?: number;
}

export class PendingApprovalRegistryImpl implements PendingApprovalRegistry {
  private entries = new Map<string, PendingEntry>();
  private cfg: Required<PendingApprovalRegistryConfig>;

  constructor(cfg: PendingApprovalRegistryConfig) {
    this.cfg = {
      capacity: DEFAULT_CAPACITY,
      ...cfg,
    };
  }

  add(
    entry: PendingEntryAdd,
  ):
    | { ok: true; promise: Promise<string> }
    | { ok: false; error: "CapacityExceededError" } {
    if (this.entries.size >= this.cfg.capacity) {
      return { ok: false, error: "CapacityExceededError" };
    }
    let resolver!: (choice: string) => void;
    let rejecter!: (err: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });
    const full: PendingEntry = {
      ...entry,
      resolver,
      rejecter,
    };
    this.entries.set(entry.pending_id, full);
    this.emitSnapshot();
    return { ok: true, promise };
  }

  lookupByPendingId(callback_data: string): PendingEntry | null {
    // callback_data format: cb_<32-char-hex pending_id>_<1-3 digit option_index>
    // Adversarial R1 W4: bound pending_id length to exactly 32 (16-byte hex)
    // and option_index to 1-3 digits (max 999) to defeat probing patterns.
    const match = /^cb_([0-9a-f]{32})_(\d{1,3})$/.exec(callback_data);
    if (!match) return null;
    const pid = match[1]!;
    return this.entries.get(pid) ?? null;
  }

  async resolveApproval(
    pending_id: string,
    choice: string,
    callback_query_id: string,
    tg: TelegramAPIClient,
  ): Promise<{ ok: true } | { ok: false; error: "unknown_pending" }> {
    const entry = this.entries.get(pending_id);
    if (!entry) return { ok: false, error: "unknown_pending" };
    // Dismiss the inline-button spinner BEFORE resolving the Promise (ordering invariant).
    try {
      await tg.answerCallbackQuery({ callback_query_id });
    } catch (err) {
      // Best-effort — answerCallbackQuery is non-critical for resolution.
      // Log via M008 so a permanent auth failure surfaces (per audit Round 1 W4).
      this.cfg.eventBus.emit("log_emit", {
        level: "WARN",
        event_type: "answer_callback_query_failed",
        fields: {
          callback_query_id,
          pending_id,
          error: String((err as Error)?.message ?? err),
        },
      });
    }
    entry.resolver(choice);
    this.entries.delete(pending_id);
    this.emitSnapshot();
    return { ok: true };
  }

  async cleanupBySession(
    session_id: string,
    tg: TelegramAPIClient,
  ): Promise<{ cleaned: number }> {
    let cleaned = 0;
    const toRemove: string[] = [];
    for (const [pid, entry] of this.entries) {
      if (entry.requester_session_id === session_id) {
        toRemove.push(pid);
      }
    }
    for (const pid of toRemove) {
      const entry = this.entries.get(pid)!;
      // Adversarial R1 W1: delete entry FIRST so a racing callback lookup can't
      // resolve a Promise we just rejected (audit trail integrity).
      this.entries.delete(pid);
      // Reject the awaiting Promise
      try {
        entry.rejecter(new Error("session_terminated"));
      } catch {
        /* ignore */
      }
      // Edit the inline-button message to indicate cancellation (best-effort)
      try {
        await tg.editMessageText({
          chat_id: entry.chat_id,
          message_id: entry.message_id,
          text: "approval cancelled (session ended)",
        });
      } catch {
        /* best-effort */
      }
      cleaned += 1;
    }
    // Single snapshot per cleanup batch (audit Round 1 W3 fix — was per-entry)
    if (cleaned > 0) this.emitSnapshot();
    return { cleaned };
  }

  size(): number {
    return this.entries.size;
  }

  capacity(): number {
    return this.cfg.capacity;
  }

  private emitSnapshot(): void {
    this.cfg.eventBus.emit("pending_capacity_snapshot", {
      current: this.entries.size,
      max: this.cfg.capacity,
    });
  }
}
