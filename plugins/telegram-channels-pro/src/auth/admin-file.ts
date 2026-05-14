import * as fs from "node:fs";
import { atomicWriteFile } from "../common/atomic-write";
import { verifyFileOwnerAndMode } from "../common/file-perms";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";

export interface AdminFileContent {
  tg_user_id: number;
  created_at: number;
  source: "file";
}

export function readAdminFile(stateDir: StateDir, eventBus: EventBus): AdminFileContent | null {
  const path = stateDir.adminFile;
  if (!fs.existsSync(path)) return null;
  verifyFileOwnerAndMode(path, { expectedMode: 0o600, restoreOnOwnerMatch: true }, eventBus);
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as AdminFileContent;
    if (typeof parsed.tg_user_id !== "number" || !Number.isFinite(parsed.tg_user_id) || parsed.tg_user_id <= 0) {
      return null;
    }
    return {
      tg_user_id: parsed.tg_user_id,
      created_at: typeof parsed.created_at === "number" ? parsed.created_at : Date.now(),
      source: "file",
    };
  } catch {
    // malformed → treat as missing per MODULE-006 §2.8
    try {
      fs.unlinkSync(path);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export async function writeAdminFile(stateDir: StateDir, tgUserId: number): Promise<void> {
  const content: AdminFileContent = {
    tg_user_id: tgUserId,
    created_at: Date.now(),
    source: "file",
  };
  await atomicWriteFile(stateDir.adminFile, JSON.stringify(content), 0o600);
}

export function deleteAdminFile(stateDir: StateDir): boolean {
  try {
    fs.unlinkSync(stateDir.adminFile);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
