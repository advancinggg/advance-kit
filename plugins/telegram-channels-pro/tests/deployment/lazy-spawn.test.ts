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
  test("MODULE-007-T09 — daemon-spawn.sh forks daemon; reports 'spawned' when socket appears within deadline", () => {
    const home = mkTmpHome();
    const stateDir = path.join(home, "Library", "Application Support", "advance-kit", "telegram-channels-pro");
    fs.mkdirSync(stateDir, { recursive: true });
    // Mock 'bun': create the socket marker file (mock the daemon's UDS bind),
    // then sleep so the parent's kill -0 sees it alive.
    const sockPath = path.join(stateDir, "daemon.sock");
    const fakeBun = mkMockBun(`touch "${sockPath}" && sleep 1 && exit 0`);
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
    // Note: TGCP_HOME is honored but the helper resolves STATE_DIR via TGCP_STATE_DIR
    // primarily; if the helper falls back to $HOME, it's also fine since both point to
    // the same tmp location. The socket path mock above accommodates either.
    const stderr = new TextDecoder().decode(proc.stderr);
    // Adversarial fix: helper now distinguishes "socket appeared = ok exit 0" vs
    // "socket never appeared = error exit 1". With the socket-touch mock above,
    // expect exit 0 + spawned/attaching message.
    expect(proc.exitCode).toBe(0);
    expect(stderr).toMatch(/spawned|attaching/);
  });

  test("MODULE-007-T09b — daemon-spawn.sh exits non-zero with clear error if socket never appears (boot-failure path)", () => {
    const home = mkTmpHome();
    // Mock 'bun': exit 1 immediately without creating socket (simulates boot-failure)
    const fakeBun = mkMockBun("exit 1");
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
    expect(proc.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toMatch(/ERROR/);
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
