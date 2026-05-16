import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/daemon/event-bus";
import { StateDirImpl, type StateDirSpec } from "../../src/daemon/state-dir";

export interface TmpStateDir {
  root: string;
  logDir: string;
  spec: StateDirSpec;
  stateDir: StateDirImpl;
  eventBus: EventBus;
  cleanup(): void;
}

export function makeTmpStateDir(eventBus?: EventBus): TmpStateDir {
  const id = randomBytes(4).toString("hex");
  const root = path.join(os.tmpdir(), `tgcp-test-${id}`);
  const logDir = path.join(os.tmpdir(), `tgcp-test-${id}-logs`);
  const spec: StateDirSpec = {
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
  const bus = eventBus ?? new EventBus();
  const stateDir = new StateDirImpl(spec, bus);
  return {
    root,
    logDir,
    spec,
    stateDir,
    eventBus: bus,
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
