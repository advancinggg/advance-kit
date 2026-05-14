import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const PLUGIN_DIR = path.resolve(__dirname, "../..");
const HELPER = path.join(PLUGIN_DIR, "bin/launchctl-helper.sh");

describe("MODULE-007-AC-15: non-macOS refuse", () => {
  test("MODULE-007-T15 — install on non-Darwin (mocked uname returning 'Linux') exits non-zero with clear error", () => {
    // Create a mock uname that returns "Linux" and prepend its dir to PATH
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgcp-test-uname-${randomBytes(2).toString("hex")}-`));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const unameMock = path.join(dir, "uname");
    fs.writeFileSync(unameMock, "#!/bin/bash\nif [ \"$1\" = \"-s\" ]; then echo Linux; else uname \"$@\"; fi\n");
    fs.chmodSync(unameMock, 0o755);
    const proc = Bun.spawnSync({
      cmd: ["/bin/bash", HELPER, "install"],
      env: {
        PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TGCP_NON_INTERACTIVE: "1",
        TGCP_DEFAULT_YES: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toMatch(/macOS|Darwin/i);
  });
});
