import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { E_LOCK_HELD_WRONG_BINARY, E_LOCK_RETRY } from "./errors";
import type { EventBus } from "./event-bus";
import type { StateDir } from "./state-dir";

export interface LockHandle {
  fd: number;
  path: string;
}

export interface LockDeps {
  /** Return true if a process with `pid` is alive (process.kill(pid, 0) succeeds). */
  isProcessAlive?: (pid: number) => boolean;
  /** Return the command line for `pid` (output of `ps -p <pid> -o command=`). */
  getProcessCommand?: (pid: number) => string;
  /** Override self pid for tests. */
  selfPid?: number;
  /** Inject Node fs module for test stubbing. */
  fs?: typeof fs;
}

const MAX_ATTEMPTS = 3;
const DAEMON_BINARY_TOKENS = ["telegram-channels-pro", "daemon-main", "daemon.ts"];

function defaultIsProcessAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // process exists but signal denied
    return false;
  }
}

function defaultGetProcessCommand(pid: number): string {
  const res = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return "";
  return res.stdout.trim();
}

export async function acquireDaemonLock(
  stateDir: StateDir,
  eventBus: EventBus,
  deps: LockDeps = {},
): Promise<LockHandle | null> {
  const lockPath = stateDir.lockFile;
  const fsMod = deps.fs ?? fs;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const getCmd = deps.getProcessCommand ?? defaultGetProcessCommand;
  const selfPid = deps.selfPid ?? process.pid;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      fd = fsMod.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock exists — validate.
      const decision = validateExistingLock(lockPath, isAlive, getCmd, selfPid, fsMod);
      if (decision.kind === "live_matching") {
        eventBus.emit("lock_event", { kind: "contention_exit" });
        return null;
      }
      if (decision.kind === "live_wrong_binary") {
        throw new E_LOCK_HELD_WRONG_BINARY(decision.pid, decision.command);
      }
      // dead → unlink and retry
      try {
        fsMod.unlinkSync(lockPath);
      } catch {
        /* race: someone else unlinked; fine */
      }
      eventBus.emit("lock_event", { kind: "stale_takeover", stale_pid: decision.stalePid });
      continue;
    }
    try {
      const content = `${selfPid}\n${Date.now()}\n${Bun.version}\n`;
      fsMod.writeSync(fd, content);
      fsMod.fchmodSync(fd, 0o600);
    } catch (err) {
      try {
        fsMod.closeSync(fd);
      } catch {
        /* ignore */
      }
      throw err;
    }
    // Keep fd open as a handle (POSIX advisory; main use is identification).
    return { fd, path: lockPath };
  }
  throw new E_LOCK_RETRY(MAX_ATTEMPTS);
}

type ValidationResult =
  | { kind: "live_matching" }
  | { kind: "live_wrong_binary"; pid: number; command: string }
  | { kind: "dead"; stalePid: number };

function validateExistingLock(
  lockPath: string,
  isAlive: (pid: number) => boolean,
  getCmd: (pid: number) => string,
  selfPid: number,
  fsMod: typeof fs,
): ValidationResult {
  let pid = 0;
  try {
    const content = fsMod.readFileSync(lockPath, "utf8");
    const firstLine = content.split("\n")[0] ?? "";
    pid = parseInt(firstLine, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { kind: "dead", stalePid: -1 };
    }
  } catch {
    return { kind: "dead", stalePid: -1 };
  }
  if (pid === selfPid) {
    // Should not happen; treat as dead (likely stale from our own prior crash).
    return { kind: "dead", stalePid: pid };
  }
  if (!isAlive(pid)) {
    return { kind: "dead", stalePid: pid };
  }
  const cmd = getCmd(pid);
  const matches = DAEMON_BINARY_TOKENS.some((tok) => cmd.includes(tok));
  if (matches) return { kind: "live_matching" };
  return { kind: "live_wrong_binary", pid, command: cmd };
}

export async function releaseDaemonLock(handle: LockHandle): Promise<void> {
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(handle.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Best-effort: log but don't throw on cleanup.
      process.stderr.write(`process-lock: failed to unlink ${handle.path}: ${String(err)}\n`);
    }
  }
}

/**
 * Emergency release used by bin/daemon.ts's top-level error handler.
 * Reads the lock file (if any); unlinks ONLY if the recorded pid matches our own pid.
 * Idempotent on missing/malformed lock file.
 */
export async function tryReleaseDanglingLock(): Promise<void> {
  // Re-derive the lock path from env. We cannot rely on StateDir helpers because
  // this is an emergency exit path where EventBus / StateDir instances may not exist.
  const root = process.env.TGCP_STATE_DIR && process.env.TGCP_STATE_DIR.trim().length > 0
    ? process.env.TGCP_STATE_DIR
    : path.join(process.env.HOME || "", "Library/Application Support/advance-kit/telegram-channels-pro");
  const lockPath = path.join(root, "daemon.lock");
  let content: string;
  try {
    content = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }
  const firstLine = content.split("\n")[0] ?? "";
  const pid = parseInt(firstLine, 10);
  if (!Number.isFinite(pid) || pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}
