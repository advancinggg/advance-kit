import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../../templates/com.advance.telegram-channels-pro.plist.tmpl",
);

function renderTemplate(values: Record<string, string>): string {
  let s = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  for (const [k, v] of Object.entries(values)) {
    s = s.split(`{{${k}}}`).join(v);
  }
  return s;
}

describe("MODULE-007-AC-04: plist captures TG_TOKEN env", () => {
  test("MODULE-007-T04 — rendering with TG_TOKEN substitutes the literal value into EnvironmentVariables block", () => {
    const out = renderTemplate({
      LABEL: "com.advance.telegram-channels-pro",
      BUN_BIN: "/opt/homebrew/bin/bun",
      DAEMON_BIN: "/path/to/daemon.ts",
      LOG_DIR: "/tmp/logs",
      TG_TOKEN: "test-bot-token-123",
      HOME_DIR: "/Users/test",
    });
    expect(out).toContain("test-bot-token-123");
    expect(out).toContain("<key>TELEGRAM_BOT_TOKEN</key>");
  });
});

describe("MODULE-007-AC-14: plist Label namespace (REQ-030)", () => {
  test("MODULE-007-T14 — rendered Label is com.advance.telegram-channels-pro", () => {
    const out = renderTemplate({
      LABEL: "com.advance.telegram-channels-pro",
      BUN_BIN: "/usr/bin/bun",
      DAEMON_BIN: "/x/y",
      LOG_DIR: "/tmp",
      TG_TOKEN: "t",
      HOME_DIR: "/u",
    });
    expect(out).toMatch(/<key>Label<\/key>\s*<string>com\.advance\.telegram-channels-pro<\/string>/);
  });
});

describe("MODULE-007-AC-18: plist KeepAlive=true RunAtLoad=true log paths", () => {
  test("MODULE-007-T18 — KeepAlive + RunAtLoad both true; log paths under ~/Library/Logs/advance-kit/telegram-channels-pro/", () => {
    const out = renderTemplate({
      LABEL: "com.advance.telegram-channels-pro",
      BUN_BIN: "/usr/bin/bun",
      DAEMON_BIN: "/x/y",
      LOG_DIR: "/Users/test/Library/Logs/advance-kit/telegram-channels-pro",
      TG_TOKEN: "t",
      HOME_DIR: "/Users/test",
    });
    expect(out).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(out).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(out).toContain("/Library/Logs/advance-kit/telegram-channels-pro/daemon.out");
    expect(out).toContain("/Library/Logs/advance-kit/telegram-channels-pro/daemon.err");
  });
});
