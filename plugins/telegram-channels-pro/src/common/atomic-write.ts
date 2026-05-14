import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomically write `content` to `targetPath` by writing to a sibling tmpfile then renaming.
 * The tmpfile is created with mode 0o600 (regardless of process umask).
 * On any error, the tmpfile is unlinked.
 */
export async function atomicWriteFile(targetPath: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `.${base}.tmp-${randomBytes(4).toString("hex")}`);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    if (typeof content === "string") {
      fs.writeSync(fd, content);
    } else {
      fs.writeSync(fd, content, 0, content.byteLength, 0);
    }
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
