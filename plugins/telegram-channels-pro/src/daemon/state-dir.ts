import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { E_STATE_DIR_PERMS } from "./errors";
import type { EventBus } from "./event-bus";

export interface StateDirSpec {
  readonly root: string;
  readonly lockFile: string;
  readonly socketFile: string;
  readonly controlSocketFile: string;
  readonly adminFile: string;
  readonly offsetFile: string;
  readonly attachmentDir: string;
  readonly logDir: string;
  readonly lastShutdownFile: string;
}

export interface StateDir extends StateDirSpec {
  initialize(): Promise<void>;
  /**
   * REQ-045 — one-shot read of the previous-shutdown cause for M003 reconnect classification.
   * First call: reads lastShutdownFile (deleting on success → 'sigterm'); falls back to
   * XPC_SERVICE_NAME env-var presence (launchd-spawned → 'keepalive'); else 'none'.
   * Subsequent calls in the same daemon process return 'none' (cached one-shot).
   */
  getPostBootShutdownContext(): "sigterm" | "keepalive" | "none";
}

const DEFAULT_STATE_SUBPATH = "Library/Application Support/advance-kit/telegram-channels-pro";
const DEFAULT_LOG_SUBPATH = "Library/Logs/advance-kit/telegram-channels-pro";

export function resolveStateDir(env: NodeJS.ProcessEnv, homedir: string): StateDirSpec {
  const override = env.TGCP_STATE_DIR;
  const root = override && override.trim().length > 0 ? path.resolve(override) : path.join(homedir, DEFAULT_STATE_SUBPATH);
  const logDirOverride = env.TGCP_LOG_DIR;
  const logDir = logDirOverride && logDirOverride.trim().length > 0
    ? path.resolve(logDirOverride)
    : path.join(homedir, DEFAULT_LOG_SUBPATH);
  return {
    root,
    lockFile: path.join(root, "daemon.lock"),
    socketFile: path.join(root, "daemon.sock"),
    controlSocketFile: path.join(root, "daemon.ctl.sock"),
    adminFile: path.join(root, "admin.json"),
    offsetFile: path.join(root, "offset.json"),
    attachmentDir: path.join(root, "attachments"),
    logDir,
    lastShutdownFile: path.join(root, "last_shutdown.json"),
  };
}

export class StateDirImpl implements StateDir {
  readonly root: string;
  readonly lockFile: string;
  readonly socketFile: string;
  readonly controlSocketFile: string;
  readonly adminFile: string;
  readonly offsetFile: string;
  readonly attachmentDir: string;
  readonly logDir: string;
  readonly lastShutdownFile: string;

  // REQ-045: one-shot post-boot shutdown-context cache. Null until first getPostBootShutdownContext()
  // call resolves; thereafter holds the resolved value. After first read, subsequent calls return 'none'.
  private shutdownContextResolved: "sigterm" | "keepalive" | "none" | null = null;

  constructor(spec: StateDirSpec, private eventBus: EventBus) {
    this.root = spec.root;
    this.lockFile = spec.lockFile;
    this.socketFile = spec.socketFile;
    this.controlSocketFile = spec.controlSocketFile;
    this.adminFile = spec.adminFile;
    this.offsetFile = spec.offsetFile;
    this.attachmentDir = spec.attachmentDir;
    this.logDir = spec.logDir;
    this.lastShutdownFile = spec.lastShutdownFile;
  }

  getPostBootShutdownContext(): "sigterm" | "keepalive" | "none" {
    if (this.shutdownContextResolved !== null) {
      // One-shot consumed: subsequent calls in the same daemon process return 'none'.
      // (Documented limitation: in launchd KeepAlive restarts with multiple parallel
      // claude reconnects, only the first session_init learns the cause — REQ-017 SLO
      // accepts the N-1 overcount within RISK-012 same-uid trust model.)
      return "none";
    }
    let result: "sigterm" | "keepalive" | "none";
    try {
      // Check for last_shutdown.json marker (SIGTERM-written by shutdown.ts).
      const content = fs.readFileSync(this.lastShutdownFile, "utf8");
      // Adversarial-review hardening: validate JSON structure to reject empty/garbage
      // files pre-placed by a same-uid process trying to coerce sigterm classification.
      let valid = false;
      try {
        const parsed = JSON.parse(content) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as { reason?: unknown }).reason === "sigterm"
        ) {
          valid = true;
        }
      } catch {
        /* malformed JSON */
      }
      try { fs.unlinkSync(this.lastShutdownFile); } catch { /* best-effort */ }
      if (valid) {
        result = "sigterm";
      } else {
        // Marker file existed but didn't validate — emit observability event and
        // treat as no-marker (fall through to XPC check below).
        this.eventBus.emit("log_emit", {
          level: "WARN",
          event_type: "post_boot_marker_invalid",
          fields: { path: this.lastShutdownFile, reason: "malformed_or_unexpected_content" },
        });
        // Re-evaluate via the no-marker branch logic.
        if (process.env.XPC_SERVICE_NAME) {
          result = "keepalive";
        } else {
          result = "none";
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Normal case: no marker file. Fall back to launchd KeepAlive detection.
        if (process.env.XPC_SERVICE_NAME) {
          result = "keepalive";
        } else {
          result = "none";
        }
      } else {
        // Unexpected errno (EACCES, EIO, etc.) — surface via observability event;
        // do not silently swallow.
        this.eventBus.emit("log_emit", {
          level: "WARN",
          event_type: "post_boot_marker_read_error",
          fields: { path: this.lastShutdownFile, code: code ?? "unknown" },
        });
        result = "none";
      }
    }
    this.shutdownContextResolved = result;
    return result;
  }

  /**
   * Internal — invoked by shutdown.ts SIGTERM handler ONLY. Not part of the public StateDir
   * interface (keeps the surface minimal; prevents downstream forgery of post-boot context).
   */
  writeShutdownMarker(reason: "sigterm"): void {
    try {
      fs.writeFileSync(
        this.lastShutdownFile,
        JSON.stringify({ reason, ts: Date.now(), daemon_pid: process.pid }),
      );
    } catch {
      // Best-effort: if write fails, next reconnect classifies 'spurious' (true positive of unexpected death).
    }
  }

  async initialize(): Promise<void> {
    await this.ensureDirAt0700(this.root);
    await this.ensureDirAt0700(this.logDir);
    // Best-effort attachments dir (0700 — same as root, contains arbitrary attachment bytes).
    try {
      fs.mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private async ensureDirAt0700(dirPath: string): Promise<void> {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dirPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!stat) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
      // Some filesystems ignore mode at creation time; explicit chmod.
      fs.chmodSync(dirPath, 0o700);
      return;
    }
    if (!stat.isDirectory()) {
      throw new E_STATE_DIR_PERMS(dirPath, stat.mode & 0o777, 0o700, stat.uid, process.getuid ? process.getuid() : -1);
    }
    const selfUid = process.getuid ? process.getuid() : -1;
    const observedMode = stat.mode & 0o777;
    if (observedMode === 0o700) return;
    if (stat.uid !== selfUid) {
      this.eventBus.emit("state_dir_perms_anomaly", {
        path: dirPath,
        expected: "0700",
        observed: "0" + observedMode.toString(8),
        action: "refused",
      });
      throw new E_STATE_DIR_PERMS(dirPath, observedMode, 0o700, stat.uid, selfUid);
    }
    fs.chmodSync(dirPath, 0o700);
    this.eventBus.emit("state_dir_perms_anomaly", {
      path: dirPath,
      expected: "0700",
      observed: "0" + observedMode.toString(8),
      action: "restored",
    });
  }
}

export function defaultStateDir(env: NodeJS.ProcessEnv, eventBus: EventBus): StateDirImpl {
  const homedir = os.homedir();
  if (!homedir) throw new Error("os.homedir() returned empty value");
  return new StateDirImpl(resolveStateDir(env, homedir), eventBus);
}
