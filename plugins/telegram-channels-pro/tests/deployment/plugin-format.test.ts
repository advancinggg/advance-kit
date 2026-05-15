import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PLUGIN_JSON = path.join(REPO_ROOT, "plugins/telegram-channels-pro/.claude-plugin/plugin.json");
const MARKETPLACE_JSON = path.join(REPO_ROOT, ".claude-plugin/marketplace.json");
const README_EN = path.join(REPO_ROOT, "README.md");
const README_ZH = path.join(REPO_ROOT, "README.zh-CN.md");
const README_ES = path.join(REPO_ROOT, "README.es.md");

describe("MODULE-007-AC-10: plugin.json shape", () => {
  test("MODULE-007-T10 — plugin.json has name, version, description, author.name", () => {
    const raw = fs.readFileSync(PLUGIN_JSON, "utf-8");
    const json = JSON.parse(raw) as { name: string; version: string; description: string; author: { name: string } };
    expect(json.name).toBe("telegram-channels-pro");
    expect(json.version).toBe("0.1.1");
    expect(typeof json.description).toBe("string");
    expect(json.description.length).toBeGreaterThan(0);
    expect(json.author?.name).toBe("Advance Studio");
  });
});

describe("MODULE-007-AC-11: marketplace.json entry", () => {
  test("MODULE-007-T11 — telegram-channels-pro entry present in marketplace.json with version matching plugin.json", () => {
    const raw = fs.readFileSync(MARKETPLACE_JSON, "utf-8");
    const market = JSON.parse(raw) as { plugins: Array<{ name: string; version: string }> };
    const entry = market.plugins.find((p) => p.name === "telegram-channels-pro");
    expect(entry).toBeDefined();
    expect(entry!.version).toBe("0.1.1");
    const pluginJson = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf-8")) as { version: string };
    expect(entry!.version).toBe(pluginJson.version);
  });
});

describe("MODULE-007-AC-12: 5-sync-point version agreement", () => {
  test("MODULE-007-T12 — version 0.1.0 appears in plugin.json + marketplace.json + 3 READMEs (telegram-channels-pro row)", () => {
    const pluginJson = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf-8")) as { version: string };
    expect(pluginJson.version).toBe("0.1.1");
    const marketplace = JSON.parse(fs.readFileSync(MARKETPLACE_JSON, "utf-8")) as {
      plugins: Array<{ name: string; version: string }>;
    };
    const tgcp = marketplace.plugins.find((p) => p.name === "telegram-channels-pro");
    expect(tgcp?.version).toBe("0.1.1");
    // README rows: must contain `telegram-channels-pro` AND `0.1.0` on the same line
    const checkReadme = (filePath: string): boolean => {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      return lines.some((l) => l.includes("telegram-channels-pro") && l.includes("0.1.1"));
    };
    expect(checkReadme(README_EN)).toBe(true);
    expect(checkReadme(README_ZH)).toBe(true);
    expect(checkReadme(README_ES)).toBe(true);
  });
});

describe("MODULE-007-AC-16: plugin.json version field present (RISK-009 doc-only)", () => {
  test("MODULE-007-T16 — plugin.json has a version field (peer-dep is doc-only NOT a plugin.json field)", () => {
    const json = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf-8")) as Record<string, unknown>;
    expect(typeof json.version).toBe("string");
  });
});
