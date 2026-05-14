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
const SPAWN_HELPER = path.join(PLUGIN_DIR, "bin/daemon-spawn.sh");

function mkTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgcp-test-spawn-home-${randomBytes(2).toString("hex")}-`));
  fs.mkdirSync(path.join(dir, "Library", "Logs", "advance-kit", "telegram-channels-pro"), { recursive: true });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkMockBun(scriptBody: string): string {
  // Create a fake "bun" executable that runs scriptBody when invoked
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgcp-test-bun-${randomBytes(2).toString("hex")}-`));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binPath = path.join(dir, "fake-bun");
  fs.writeFileSync(binPath, `#!/bin/bash\n${scriptBody}\n`);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

describe("MODULE-007-AC-09/AC-17: lazy-spawn entry point", () => {
  test("MODULE-007-T09 — daemon-spawn.sh forks daemon; reports 'spawned' or 'attaching' to stderr", () => {
    const home = mkTmpHome();
    // Mock 'bun': sleep 1 so the parent's `kill -0` check sees it alive
    const fakeBun = mkMockBun("sleep 1\nexit 0");
    const fakeDaemon = path.join(mkTmpHome(), "fake-daemon.ts");
    fs.writeFileSync(fakeDaemon, "// fake daemon entry");
    const proc = Bun.spawnSync({
      cmd: ["/bin/bash", SPAWN_HELPER],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TGCP_HOME: home,
        TGCP_BUN_BIN: fakeBun,
        TGCP_DAEMON_BIN: fakeDaemon,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const stderr = new TextDecoder().decode(proc.stderr);
    // Either "spawned" (success) or "attaching" (lock loser path) is acceptable
    expect(stderr).toMatch(/spawned|attaching/);
  });

  test("MODULE-007-T17 — daemon-spawn.sh fails clean if BUN_BIN is missing", () => {
    const home = mkTmpHome();
    const proc = Bun.spawnSync({
      cmd: ["/bin/bash", SPAWN_HELPER],
      env: {
        PATH: "/dev/null", // no bun in PATH
        TGCP_HOME: home,
        TGCP_BUN_BIN: "/nonexistent/bun",
        TGCP_DAEMON_BIN: "/nonexistent/daemon.ts",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    const stderr = new TextDecoder().decode(proc.stderr);
    // Either bun missing OR daemon missing surfaces as a clear ERROR
    expect(stderr).toMatch(/ERROR/);
  });
});
