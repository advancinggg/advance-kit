import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ROLLBACK_PATH = path.join(REPO_ROOT, "docs/ROLLBACK.md");

describe("MODULE-007-AC-13: ROLLBACK.md authored", () => {
  test("MODULE-007-T13 — ROLLBACK.md exists and contains 3 triggers + diagnostic + execution sections", () => {
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const content = fs.readFileSync(ROLLBACK_PATH, "utf-8");
    expect(content).toMatch(/##\s+Rollback triggers/i);
    // 3 numbered trigger criteria
    expect(content).toMatch(/1\.\s+\*\*Inbound silent-failure/);
    expect(content).toMatch(/2\.\s+\*\*Cross-process SIGTERM/);
    expect(content).toMatch(/3\.\s+\*\*Approval round-trip failures/);
    expect(content).toMatch(/##\s+Diagnostic steps/i);
    expect(content).toMatch(/##\s+Execution steps/i);
    expect(content).toMatch(/##\s+Version revert/i);
  });
});
