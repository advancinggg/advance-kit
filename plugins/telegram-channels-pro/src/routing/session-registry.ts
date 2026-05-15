import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import { shortHash } from "../common/hash";

const DEFAULT_CAPACITY = 8;

export interface SessionEntry {
  session_id: string;
  shortid: string;
  branch: string;
  registered_at: number;
  last_activity_at: number;
}

export interface SessionRegistryConfig {
  eventBus: EventBus;
  clock: Clock;
  capacity?: number;
  /** Called when capacity exceeded to disconnect the rejected session. */
  disconnectSession: (session_id: string, reason: "capacity_exceeded") => Promise<void> | void;
}

/**
 * In-memory LRU ordered list (head = most-recent activity).
 *
 * Updates from EventBus events:
 * - session_connected → add to head (with capacity guard); emit route_decision: session_added
 * - session_disconnected → remove; emit route_decision: session_removed
 * - tool_call → bump matching session's last_activity_at + move to head
 * - TG inbound message → does NOT update LRU (PRD §3.1 routing snapshot rule)
 */
export class SessionRegistry {
  private cfg: Required<Omit<SessionRegistryConfig, "disconnectSession">> & {
    disconnectSession: SessionRegistryConfig["disconnectSession"];
  };
  /** Head = most recent activity. */
  private orderedEntries: SessionEntry[] = [];
  private unsubs: Array<() => void> = [];

  constructor(cfg: SessionRegistryConfig) {
    // Explicit assignment — same constructor-spread anti-pattern fix as
    // PendingApprovalRegistry / SnapshotEmitter / AttachmentJanitor.
    this.cfg = {
      eventBus: cfg.eventBus,
      clock: cfg.clock,
      capacity: cfg.capacity ?? DEFAULT_CAPACITY,
      disconnectSession: cfg.disconnectSession,
    };
  }

  /**
   * Subscribe to EventBus events. Call once at install time. Returns unsub
   * fn (also accumulated in this.unsubs for dispose()).
   */
  installSubscribers(): void {
    const u1 = this.cfg.eventBus.on("session_connected", (payload) => {
      const p = payload as { session_id: string; shortid: string; branch?: string; ts: number };
      void this.handleSessionConnected(p);
    });
    const u2 = this.cfg.eventBus.on("session_disconnected", (payload) => {
      const p = payload as { session_id: string };
      this.handleSessionDisconnected(p.session_id);
    });
    const u3 = this.cfg.eventBus.on("tool_call", (payload) => {
      const p = payload as { session_id: string };
      this.handleToolCall(p.session_id);
    });
    this.unsubs.push(u1, u2, u3);
  }

  private async handleSessionConnected(p: {
    session_id: string;
    shortid: string;
    branch?: string;
    ts: number;
  }): Promise<void> {
    if (this.orderedEntries.length >= this.cfg.capacity) {
      // Capacity exceeded — emit auth_deny + disconnect
      this.cfg.eventBus.emit("auth_deny_routing", {
        sender_hash: "",
        reason: "session_capacity_exceeded",
      });
      try {
        await this.cfg.disconnectSession(p.session_id, "capacity_exceeded");
      } catch {
        /* best-effort */
      }
      return;
    }
    const entry: SessionEntry = {
      session_id: p.session_id,
      shortid: p.shortid,
      branch: p.branch ?? "",
      registered_at: p.ts,
      last_activity_at: p.ts,
    };
    this.orderedEntries.unshift(entry);
    this.cfg.eventBus.emit("route_decision", {
      update_id: -1,
      target_session: p.session_id,
      reason: "session_added",
    });
  }

  private handleSessionDisconnected(session_id: string): void {
    const idx = this.orderedEntries.findIndex((e) => e.session_id === session_id);
    if (idx < 0) return;
    this.orderedEntries.splice(idx, 1);
    this.cfg.eventBus.emit("route_decision", {
      update_id: -1,
      target_session: session_id,
      reason: "session_removed",
    });
  }

  private handleToolCall(session_id: string): void {
    this.bumpActivity(session_id);
  }

  bumpActivity(session_id: string): void {
    const idx = this.orderedEntries.findIndex((e) => e.session_id === session_id);
    if (idx < 0) return;
    const entry = this.orderedEntries.splice(idx, 1)[0]!;
    entry.last_activity_at = this.cfg.clock.now();
    this.orderedEntries.unshift(entry);
  }

  getFocus(): SessionEntry | null {
    return this.orderedEntries[0] ?? null;
  }

  size(): number {
    return this.orderedEntries.length;
  }

  /** Snapshot for /list — returned in head-first order (most recent first). */
  entries(): SessionEntry[] {
    return [...this.orderedEntries];
  }

  /** Find a session whose shortid starts with the given prefix. */
  findByShortIdPrefix(prefix: string): SessionEntry | null {
    return this.orderedEntries.find((e) => e.shortid.startsWith(prefix)) ?? null;
  }

  /** Remove a session by id without emitting events (used by stale-deliver fallback). */
  removeStale(session_id: string): void {
    const idx = this.orderedEntries.findIndex((e) => e.session_id === session_id);
    if (idx >= 0) this.orderedEntries.splice(idx, 1);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.orderedEntries = [];
  }

  // shortHash is re-exported for sender_hash computation in dispatcher
  static shortHash(s: string): string {
    return shortHash(s);
  }
}
