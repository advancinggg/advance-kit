import { describe, expect, test } from "bun:test";
import { redactPayload, redactProjectPath, redactString } from "../../src/obs/redaction";

describe("MODULE-008-AC-04: bot_token redaction", () => {
  test("MODULE-008-T04 — bot token regex substituted with bot[REDACTED]", () => {
    const out = redactString("token leaked: bot1234567:ABCdef-GhIJ_KlMnO0p");
    expect(out).toContain("bot[REDACTED]");
    expect(out).not.toContain("ABCdef-GhIJ");
  });

  test("redactPayload recursively redacts in nested objects", () => {
    const out = redactPayload({ token: "bot12345:abc", nested: { url: "https://api.tg.org/bot12345:abc/sendMessage" } }) as Record<string, unknown>;
    expect(out.token).toBe("bot[REDACTED]");
    expect(String((out.nested as Record<string, unknown>).url)).toContain("bot[REDACTED]");
  });
});

describe("MODULE-008-AC-05: TG user_id hashing", () => {
  test("MODULE-008-T05 — tg_user_id → 12-char hex prefix in output", () => {
    const out = redactPayload({ tg_user_id: 12345 }) as Record<string, unknown>;
    const hashed = String(out.tg_user_id);
    expect(hashed).not.toBe("12345");
    expect(hashed.length).toBe(12);
    expect(/^[0-9a-f]{12}$/.test(hashed)).toBe(true);
  });

  test("from.id inside an update object is also hashed", () => {
    const out = redactPayload({ from: { id: 9999, name: "bob" } }) as Record<string, unknown>;
    const from = out.from as Record<string, unknown>;
    expect(from.id).not.toBe(9999);
    expect(String(from.id).length).toBe(12);
  });
});

describe("MODULE-008-AC-06: DM text + tool params fingerprint", () => {
  test("MODULE-008-T06 — message_text → {hash, length}", () => {
    const out = redactPayload({ message_text: "hello world" }) as Record<string, unknown>;
    const f = out.message_text as { hash: string; length: number };
    expect(f.length).toBe(11);
    expect(f.hash.length).toBe(12);
  });
});

describe("MODULE-008-AC-07: project_path redaction", () => {
  test("MODULE-008-T07 — long path → /<first>/.../<leaf>", () => {
    const r = redactProjectPath("/Users/me/Work/secret-project/src");
    expect(r).toBe("/Users/.../src");
  });

  test("short path unchanged (2 segments or less)", () => {
    expect(redactProjectPath("/a/b")).toBe("/a/b");
    expect(redactProjectPath("/single")).toBe("/single");
  });

  test("nested project_path key redacts", () => {
    const out = redactPayload({ project_path: "/Users/x/Work/y/src" }) as Record<string, unknown>;
    expect(out.project_path).toBe("/Users/.../src");
  });
});

describe("MODULE-008-AC-08: registration code redaction", () => {
  test("MODULE-008-T08 — 6-char alnum code from alphabet → code[REDACTED]", () => {
    const out = redactString("Send `register ABCDEF` to bot");
    expect(out).toContain("code[REDACTED]");
    expect(out).not.toContain("ABCDEF");
  });
});
