import { randomBytes } from "node:crypto";

export interface SocketLike {
  write(data: Uint8Array): boolean | Promise<boolean>;
  end(): void;
  destroy(err?: Error): void;
}

export interface SessionEntry {
  session_id: string;
  shortid: string;
  branch?: string;
  socket: SocketLike;
  /** request_id ↔ resolver for in-flight tool_call frames originated by the SERVER side. */
  pending: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
  connectedAt: number;
}

export class SessionMap {
  private byId = new Map<string, SessionEntry>();

  allocateSessionId(): string {
    return randomBytes(8).toString("hex");
  }

  add(entry: SessionEntry): void {
    this.byId.set(entry.session_id, entry);
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.byId.get(sessionId);
  }

  remove(sessionId: string): SessionEntry | undefined {
    const e = this.byId.get(sessionId);
    if (e) this.byId.delete(sessionId);
    return e;
  }

  size(): number {
    return this.byId.size;
  }

  values(): IterableIterator<SessionEntry> {
    return this.byId.values();
  }
}
