import * as fs from "node:fs";
import { connect as netConnect } from "node:net";
import type { EventBus } from "./event-bus";
import type { LockHandle } from "./process-lock";
import { releaseDaemonLock } from "./process-lock";
import type { StateDir } from "./state-dir";

export interface ShutdownArgs {
  eventBus: EventBus;
  lockHandle: LockHandle;
  stateDir: StateDir;
  bootTs: number;
  /** Override process.exit for tests. */
  exitFn?: (code: number) => void;
  /** Override the post-emit flush wait. Default: 200ms. */
  flushBarrierMs?: number;
}

export interface ShutdownCtl {
  requestShutdown(reason: string, exitCode?: number): Promise<void>;
  uninstall(): void;
}

export function installShutdownHandlers(args: ShutdownArgs): ShutdownCtl {
  const exitFn = args.exitFn ?? ((code: number) => process.exit(code));
  const flushBarrierMs = args.flushBarrierMs ?? 200;
  let shuttingDown = false;
  let resolveShutdown: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((res) => {
    resolveShutdown = res;
  });

  async function doShutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) {
      // Re-entrant; wait for the in-flight shutdown.
      await shutdownPromise;
      return;
    }
    shuttingDown = true;
    // REQ-045 — on SIGTERM only, write a marker so the next post-boot session_init classifies
    // as 'sigterm'. writeShutdownMarker is intentionally NOT on the public StateDir interface;
    // cast via structural type so test stubs without the method don't crash.
    if (reason === "SIGTERM") {
      const sd = args.stateDir as { writeShutdownMarker?: (reason: "sigterm") => void };
      sd.writeShutdownMarker?.("sigterm");
    }
    const uptimeMs = Date.now() - args.bootTs;
    args.eventBus.emit("daemon_stop", { pid: process.pid, reason, uptime_ms: uptimeMs });
    // Flush barrier — give subscribers a chance to act before we tear down.
    await new Promise<void>((res) => setTimeout(res, flushBarrierMs));
    // Best-effort socket cleanup.
    try {
      fs.unlinkSync(args.stateDir.socketFile);
    } catch {
      /* ignore */
    }
    // Release lock.
    await releaseDaemonLock(args.lockHandle).catch(() => undefined);
    if (resolveShutdown) resolveShutdown();
    exitFn(exitCode);
  }

  const onTerm = () => {
    void doShutdown("SIGTERM", 0);
  };
  const onInt = () => {
    void doShutdown("SIGINT", 0);
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  return {
    requestShutdown: (reason: string, exitCode = 0) => doShutdown(reason, exitCode),
    uninstall: () => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    },
  };
}

export interface StaleSocketResult {
  cleaned: boolean;
  reason: "missing" | "stale_unlinked" | "live_connected";
}

/**
 * AC-21: stale socket cleanup. Attempts to connect to `socketPath`; if ECONNREFUSED → unlink.
 * If connect succeeds → another listener is alive (caller should have prevented this via lock).
 */
export async function cleanupStaleSocket(socketPath: string): Promise<StaleSocketResult> {
  let exists = false;
  try {
    fs.statSync(socketPath);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!exists) return { cleaned: false, reason: "missing" };
  // Try a non-blocking connect with a short timeout.
  const probeResult = await new Promise<"refused" | "connected" | "other_error">((res) => {
    const sock = netConnect({ path: socketPath });
    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      res("other_error");
    }, 500);
    sock.on("connect", () => {
      clearTimeout(timer);
      try {
        sock.end();
        sock.destroy();
      } catch {
        /* ignore */
      }
      res("connected");
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") res("refused");
      else res("other_error");
    });
  });
  if (probeResult === "connected") {
    return { cleaned: false, reason: "live_connected" };
  }
  // refused or other_error → unlink.
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { cleaned: true, reason: "stale_unlinked" };
}
