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
}

export interface StateDir extends StateDirSpec {
  initialize(): Promise<void>;
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

  constructor(spec: StateDirSpec, private eventBus: EventBus) {
    this.root = spec.root;
    this.lockFile = spec.lockFile;
    this.socketFile = spec.socketFile;
    this.controlSocketFile = spec.controlSocketFile;
    this.adminFile = spec.adminFile;
    this.offsetFile = spec.offsetFile;
    this.attachmentDir = spec.attachmentDir;
    this.logDir = spec.logDir;
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
