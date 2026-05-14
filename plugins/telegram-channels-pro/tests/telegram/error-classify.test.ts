import { describe, expect, test } from "bun:test";
import { classifyHttpResponse, classifyNetworkError, parseRetryAfter } from "../../src/telegram/error-classify";

describe("MODULE-002-AC-04: 409 conflict classification", () => {
  test("MODULE-002-T04 — HTTP 409 → kind='conflict_409' (not counted in fatal window)", () => {
    const c = classifyHttpResponse(409, new Headers(), { ok: false, error_code: 409 });
    expect(c.kind).toBe("conflict_409");
  });
});

describe("MODULE-002-AC-05/AC-19: 429 rate limit handling", () => {
  test("MODULE-002-T05 — HTTP 429 with Retry-After: 3 → rate_limited_429 with retryAfterSec=3", () => {
    const headers = new Headers({ "retry-after": "3" });
    const c = classifyHttpResponse(429, headers, { ok: false });
    expect(c.kind).toBe("rate_limited_429");
    if (c.kind === "rate_limited_429") expect(c.retryAfterSec).toBe(3);
  });

  test("MODULE-002-T19 — HTTP 429 with no Retry-After header defaults to 5s", () => {
    const headers = new Headers();
    const c = classifyHttpResponse(429, headers, {});
    expect(c.kind).toBe("rate_limited_429");
    if (c.kind === "rate_limited_429") expect(c.retryAfterSec).toBe(5);
  });

  test("parseRetryAfter handles malformed header gracefully", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter("not-a-number")).toBe(5);
  });
});

describe("network and 5xx classification", () => {
  test("HTTP 500 → fatal", () => {
    const c = classifyHttpResponse(500, new Headers(), { description: "oops" });
    expect(c.kind).toBe("fatal");
  });

  test("network ECONNRESET → fatal with code in reason", () => {
    const c = classifyNetworkError({ code: "ECONNRESET", message: "reset" });
    expect(c.kind).toBe("fatal");
    if (c.kind === "fatal") expect(c.reason).toContain("ECONNRESET");
  });
});
