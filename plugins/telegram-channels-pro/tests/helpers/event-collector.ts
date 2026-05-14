import type { EventBus } from "../../src/daemon/event-bus";
import { ALL_EVENT_TYPES, type EventTypeKey } from "../../src/daemon/event-types";

export interface CollectedEvent {
  type: EventTypeKey;
  payload: unknown;
}

export class EventCollector {
  public events: CollectedEvent[] = [];
  private unsubscribes: Array<() => void> = [];

  constructor(public eventBus: EventBus) {
    for (const t of ALL_EVENT_TYPES) {
      const u = eventBus.on(t, (payload: unknown) => {
        this.events.push({ type: t, payload });
      });
      this.unsubscribes.push(u);
    }
  }

  byType<K extends EventTypeKey>(type: K): CollectedEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  clear(): void {
    this.events.length = 0;
  }

  stop(): void {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
  }
}
