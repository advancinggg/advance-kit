import { describe, expect, test } from "bun:test";
import { AdminAllowlistImpl, parseAuthorizedUsersEnv } from "../../src/auth/allowlist";

describe("MODULE-006-AC-10/AC-11: AdminAllowlist isAdmin lookup", () => {
  test("MODULE-006-T10 — env-set allowlist: isAdmin(listed) true, isAdmin(other) false", () => {
    const a = new AdminAllowlistImpl();
    a.setFromEnv([1, 5, 9]);
    expect(a.isAdmin(1)).toBe(true);
    expect(a.isAdmin(5)).toBe(true);
    expect(a.isAdmin(9)).toBe(true);
    expect(a.isAdmin(99)).toBe(false);
    expect(a.source()).toBe("env");
  });

  test("MODULE-006-T11 — file-set allowlist: isAdmin(uid) true, source='file'", () => {
    const a = new AdminAllowlistImpl();
    a.setFromFile(42);
    expect(a.isAdmin(42)).toBe(true);
    expect(a.isAdmin(99)).toBe(false);
    expect(a.source()).toBe("file");
  });

  test("clear() returns to empty + source='none'", () => {
    const a = new AdminAllowlistImpl();
    a.setFromEnv([1]);
    a.clear();
    expect(a.isAdmin(1)).toBe(false);
    expect(a.source()).toBe("none");
  });
});

describe("MODULE-006-AC-18: env var parsing", () => {
  test("MODULE-006-T18 — JSON array → list of integers", () => {
    expect(parseAuthorizedUsersEnv("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("MODULE-006-T18b — single integer string → [N]", () => {
    expect(parseAuthorizedUsersEnv("123")).toEqual([123]);
  });

  test("MODULE-006-T18c — malformed env → throws", () => {
    expect(() => parseAuthorizedUsersEnv("not-json")).toThrow();
    expect(() => parseAuthorizedUsersEnv("[1, 'bad']")).toThrow();
    expect(() => parseAuthorizedUsersEnv("[1, 0]")).toThrow(); // 0 not allowed
    expect(() => parseAuthorizedUsersEnv("[1, -5]")).toThrow(); // negative not allowed
    expect(() => parseAuthorizedUsersEnv("[1.5]")).toThrow(); // non-integer
    expect(() => parseAuthorizedUsersEnv('"a-string"')).toThrow();
  });

  test("empty string → empty list (caller decides whether to enter registration)", () => {
    expect(parseAuthorizedUsersEnv("")).toEqual([]);
    expect(parseAuthorizedUsersEnv("   ")).toEqual([]);
  });
});
