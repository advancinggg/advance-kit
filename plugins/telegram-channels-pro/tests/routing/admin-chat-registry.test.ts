import { describe, expect, test } from "bun:test";
import { AdminChatRegistry } from "../../src/routing/admin-chat-registry";

describe("AdminChatRegistry — CCD-4 / CCD-10 / CCD-20", () => {
  test("constructor parses env value when set", () => {
    const r = new AdminChatRegistry("12345");
    expect(r.get()).toBe(12345);
  });

  test("constructor silently ignores undefined env", () => {
    const r = new AdminChatRegistry(undefined);
    expect(r.get()).toBeNull();
  });

  test("constructor silently ignores malformed env value (non-integer)", () => {
    const r = new AdminChatRegistry("not-a-number");
    expect(r.get()).toBeNull();
  });

  test("setFromInbound captures only chat_type=='private'", () => {
    const r = new AdminChatRegistry(undefined);
    r.setFromInbound(99, "group");
    expect(r.get()).toBeNull();
    r.setFromInbound(99, "private");
    expect(r.get()).toBe(99);
  });

  test("subscribe fires callback immediately with current value if non-null", () => {
    const r = new AdminChatRegistry("42");
    let received: number | null = null;
    r.subscribe((id) => {
      received = id;
    });
    expect(received).toBe(42);
  });

  test("subscribe fires callback on subsequent setFromInbound", () => {
    const r = new AdminChatRegistry(undefined);
    const events: Array<number | null> = [];
    r.subscribe((id) => events.push(id));
    r.setFromInbound(7, "private");
    expect(events).toEqual([7]);
    r.setFromInbound(8, "private");
    expect(events).toEqual([7, 8]);
  });

  test("setFromInbound is idempotent on duplicate chat_id", () => {
    const r = new AdminChatRegistry(undefined);
    const events: Array<number | null> = [];
    r.subscribe((id) => events.push(id));
    r.setFromInbound(5, "private");
    r.setFromInbound(5, "private");
    expect(events).toEqual([5]); // single fire
  });
});
