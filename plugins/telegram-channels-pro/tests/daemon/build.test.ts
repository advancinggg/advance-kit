import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

describe("MODULE-001-AC-18: Bun runtime + TypeScript strict compile", () => {
  test("MODULE-001-T17 — bun build src/daemon/main.ts --target=bun produces a non-empty bundle", () => {
    const tmpOut = path.join(os.tmpdir(), `tgcp-build-${Date.now()}.js`);
    const res = spawnSync("bun", ["build", "src/daemon/main.ts", "--target=bun", "--outfile", tmpOut], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(res.status).toBe(0);
    expect(fs.existsSync(tmpOut)).toBe(true);
    const stat = fs.statSync(tmpOut);
    expect(stat.size).toBeGreaterThan(1024);
    try {
      fs.unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
  });
});
