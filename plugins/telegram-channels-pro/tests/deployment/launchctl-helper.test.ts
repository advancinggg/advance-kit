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

interface MockLaunchctl {
  binPath: string;
  cleanup: () => void;
  callsLog: string;
}

function mkMockLaunchctl(behavior: "success" | "fail"): MockLaunchctl {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgcp-test-launchctl-${randomBytes(2).toString("hex")}-`));
  const callsLog = path.join(dir, "calls.log");
  const binPath = path.join(dir, "launchctl");
  const exitCode = behavior === "success" ? 0 : 78;
  // Write a tiny shell script that records its argv and exits with the desired code
  fs.writeFileSync(
    binPath,
    `#!/bin/bash\necho "$@" >> "${callsLog}"\nexit ${exitCode}\n`,
  );
  fs.chmodSync(binPath, 0o755);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { binPath, callsLog, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function mkTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgcp-test-home-${randomBytes(2).toString("hex")}-`));
  fs.mkdirSync(path.join(dir, "Library", "LaunchAgents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Library", "Application Support", "advance-kit", "telegram-channels-pro"), { recursive: true });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHelper(
  subcmd: "install" | "uninstall",
  env: Record<string, string>,
): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync({
    cmd: ["/bin/bash", HELPER, subcmd],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    code: proc.exitCode ?? -1,
  };
}

describe("MODULE-007-AC-01/AC-04: install renders plist + bootstrap; AC-04 captures TG token env", () => {
  test("MODULE-007-T01 — install with mock LAUNCHCTL_BIN=success → plist file written 0644; mock launchctl invoked with bootstrap", () => {
    const home = mkTmpHome();
    const mock = mkMockLaunchctl("success");
    const result = runHelper("install", {
      TGCP_HOME: home,
      LAUNCHCTL_BIN: mock.binPath,
      TGCP_NON_INTERACTIVE: "1",
      TGCP_DEFAULT_YES: "1",
      TELEGRAM_BOT_TOKEN: "test-token-abc",
      TGCP_DAEMON_BIN: "/fake/daemon.ts",
      TGCP_BUN_BIN: "/fake/bun",
    });
    expect(result.code).toBe(0);
    const plistPath = path.join(home, "Library/LaunchAgents/com.advance.telegram-channels-pro.plist");
    expect(fs.existsSync(plistPath)).toBe(true);
    const stat = fs.statSync(plistPath);
    expect(stat.mode & 0o777).toBe(0o644);
    const plistContent = fs.readFileSync(plistPath, "utf-8");
    expect(plistContent).toContain("test-token-abc");
    expect(plistContent).toContain("/fake/daemon.ts");
    const launchctlCalls = fs.readFileSync(mock.callsLog, "utf-8");
    expect(launchctlCalls).toContain("bootstrap");
  });
});

describe("MODULE-007-AC-02: install opt-out → lazy-spawn message", () => {
  test("MODULE-007-T02 — install with TGCP_DEFAULT_NO=1 → exit 0; plist NOT written; 'lazy-spawn' message", () => {
    const home = mkTmpHome();
    const mock = mkMockLaunchctl("success");
    const result = runHelper("install", {
      TGCP_HOME: home,
      LAUNCHCTL_BIN: mock.binPath,
      TGCP_NON_INTERACTIVE: "1",
      TGCP_DEFAULT_NO: "1",
    });
    expect(result.code).toBe(0);
    const plistPath = path.join(home, "Library/LaunchAgents/com.advance.telegram-channels-pro.plist");
    expect(fs.existsSync(plistPath)).toBe(false);
    expect(result.stdout.toLowerCase()).toContain("lazy-spawn");
  });
});

describe("MODULE-007-AC-03/AC-17: install bootstrap fails → clear error + manual instructions; install exits 0", () => {
  test("MODULE-007-T03 — install with mock LAUNCHCTL_BIN=fail → install exits 0; stderr contains manual recovery instructions", () => {
    const home = mkTmpHome();
    const mock = mkMockLaunchctl("fail");
    const result = runHelper("install", {
      TGCP_HOME: home,
      LAUNCHCTL_BIN: mock.binPath,
      TGCP_NON_INTERACTIVE: "1",
      TGCP_DEFAULT_YES: "1",
      TELEGRAM_BOT_TOKEN: "x",
    });
    // AC-03 invariant: plugin install does NOT fail (exit 0 even after launchctl bootstrap fail)
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("ERROR: launchctl bootstrap failed");
    expect(result.stderr).toContain("Manual recovery");
  });
});

describe("MODULE-007-AC-05/AC-06: uninstall path", () => {
  test("MODULE-007-T05 — install then uninstall → bootout invoked; plist unlinked", () => {
    const home = mkTmpHome();
    const mock = mkMockLaunchctl("success");
    runHelper("install", {
      TGCP_HOME: home,
      LAUNCHCTL_BIN: mock.binPath,
      TGCP_NON_INTERACTIVE: "1",
      TGCP_DEFAULT_YES: "1",
      TELEGRAM_BOT_TOKEN: "x",
    });
    const plistPath = path.join(home, "Library/LaunchAgents/com.advance.telegram-channels-pro.plist");
    expect(fs.existsSync(plistPath)).toBe(true);
    const result = runHelper("uninstall", {
      TGCP_HOME: home,
      LAUNCHCTL_BIN: mock.binPath,
      TGCP_NON_INTERACTIVE: "1",
      TGCP_DEFAULT_NO: "1",
    });
    expect(result.code).toBe(0);
    expect(fs.existsSync(plistPath)).toBe(false);
    const launchctlCalls = fs.readFileSync(mock.callsLog, "utf-8");
    expect(launchctlCalls).toContain("bootout");
  });

  test("MODULE-007-T06 — uninstall with state-dir Y prompt → state dir removed; with N → preserved", () => {
    const home = mkTmpHome();
    const mock = mkMockLaunchctl("success");
    const stateDir = path.join(home, "Library/Application Support/advance-kit/telegram-channels-pro");
    fs.writeFileSync(path.join(stateDir, "marker.txt"), "x");
    expect(fs.existsSync(path.join(stateDir, "marker.txt"))).toBe(true);
    // First: uninstall with default-no → state dir preserved
    runHelper("uninstall", { TGCP_HOME: home, LAUNCHCTL_BIN: mock.binPath, TGCP_NON_INTERACTIVE: "1", TGCP_DEFAULT_NO: "1" });
    expect(fs.existsSync(path.join(stateDir, "marker.txt"))).toBe(true);
    // Second: uninstall with default-yes → state dir removed
    runHelper("uninstall", { TGCP_HOME: home, LAUNCHCTL_BIN: mock.binPath, TGCP_NON_INTERACTIVE: "1", TGCP_DEFAULT_YES: "1" });
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});
