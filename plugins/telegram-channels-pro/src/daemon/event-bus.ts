import type { EventPayloadMap, EventTypeKey, Unsubscribe } from "./event-types";

interface BoundedQueueState {
  capacity: number;
  items: unknown[];
  draining: boolean;
}

interface Subscription {
  id: string;
  type: EventTypeKey;
  handler: (payload: unknown) => void | Promise<void>;
  queue: BoundedQueueState | null;
}

export interface OnOptions {
  queueSize?: number;
  subscriberId?: string;
}

let globalSubIdCounter = 0;

export class EventBus {
  private subscribers = new Map<EventTypeKey, Set<Subscription>>();
  /** Re-entrancy guard: when true, subscriber_queue_drop emits do NOT trigger queue overflow handling. */
  private emittingQueueDrop = false;
  /** Public counter for testability. */
  public droppedEventCount = 0;

  on<K extends EventTypeKey>(
    type: K | K[],
    handler: (payload: EventPayloadMap[K]) => void | Promise<void>,
    opts: OnOptions = {},
  ): Unsubscribe {
    const types = Array.isArray(type) ? type : [type];
    const subs: Subscription[] = [];
    for (const t of types) {
      let bucket = this.subscribers.get(t);
      if (!bucket) {
        bucket = new Set();
        this.subscribers.set(t, bucket);
      }
      const sub: Subscription = {
        id: opts.subscriberId ?? `sub-${++globalSubIdCounter}`,
        type: t,
        handler: handler as (payload: unknown) => void | Promise<void>,
        queue: opts.queueSize && opts.queueSize > 0 ? { capacity: opts.queueSize, items: [], draining: false } : null,
      };
      bucket.add(sub);
      subs.push(sub);
    }
    return () => {
      for (const sub of subs) {
        const bucket = this.subscribers.get(sub.type);
        if (bucket) bucket.delete(sub);
      }
    };
  }

  emit<K extends EventTypeKey>(type: K, payload: EventPayloadMap[K]): void {
    const bucket = this.subscribers.get(type);
    if (!bucket || bucket.size === 0) return;
    // Iterate over a snapshot so subscribers that unsubscribe during dispatch don't break iteration.
    const snapshot = Array.from(bucket);
    for (const sub of snapshot) {
      if (sub.queue) {
        this.enqueueForSubscriber(sub, payload);
      } else {
        this.invokeSync(sub, payload);
      }
    }
  }

  private invokeSync(sub: Subscription, payload: unknown): void {
    try {
      const result = sub.handler(payload);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          process.stderr.write(`EventBus async handler error in ${sub.id} for ${sub.type}: ${String(err)}\n`);
        });
      }
    } catch (err) {
      process.stderr.write(`EventBus sync handler error in ${sub.id} for ${sub.type}: ${String(err)}\n`);
    }
  }

  private enqueueForSubscriber(sub: Subscription, payload: unknown): void {
    const q = sub.queue!;
    if (q.items.length >= q.capacity) {
      // Drop oldest.
      q.items.shift();
      this.droppedEventCount += 1;
      this.notifyQueueDrop(sub.id, sub.type, 1);
    }
    q.items.push(payload);
    this.scheduleDrain(sub);
  }

  private notifyQueueDrop(subscriberId: string, eventType: EventTypeKey, dropCount: number): void {
    if (this.emittingQueueDrop) return;
    this.emittingQueueDrop = true;
    try {
      this.emit("subscriber_queue_drop", {
        subscriber_id: subscriberId,
        event_type: eventType,
        drop_count: dropCount,
      });
    } finally {
      this.emittingQueueDrop = false;
    }
  }

  private scheduleDrain(sub: Subscription): void {
    const q = sub.queue!;
    if (q.draining) return;
    q.draining = true;
    queueMicrotask(async () => {
      try {
        while (q.items.length > 0) {
          const item = q.items.shift()!;
          try {
            await sub.handler(item);
          } catch (err) {
            process.stderr.write(`EventBus async queue handler error in ${sub.id} for ${sub.type}: ${String(err)}\n`);
          }
        }
      } finally {
        q.draining = false;
      }
    });
  }

  subscriberCount(type: EventTypeKey): number {
    return this.subscribers.get(type)?.size ?? 0;
  }
}
