import * as fs from "node:fs";
import { atomicWriteFile } from "../common/atomic-write";
import { verifyFileOwnerAndMode } from "../common/file-perms";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";

interface OffsetFileContent {
  offset: number;
  ts: number;
}

export class OffsetManager {
  private currentOffset = 0;
  private loaded = false;

  constructor(private stateDir: StateDir, private eventBus: EventBus) {
    this.eventBus.on("daemon_stop", () => {
      // Best-effort flush before exit.
      void this.flush();
    });
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const path = this.stateDir.offsetFile;
    if (!fs.existsSync(path)) {
      this.currentOffset = 0;
      this.loaded = true;
      return;
    }
    try {
      verifyFileOwnerAndMode(path, { expectedMode: 0o600, restoreOnOwnerMatch: true }, this.eventBus);
    } catch {
      // perms refused → start at 0 (file may be untrusted).
      this.currentOffset = 0;
      this.loaded = true;
      return;
    }
    try {
      const content = fs.readFileSync(path, "utf8");
      const parsed = JSON.parse(content) as OffsetFileContent;
      if (typeof parsed.offset === "number" && Number.isFinite(parsed.offset) && parsed.offset >= 0) {
        this.currentOffset = parsed.offset;
      } else {
        this.currentOffset = 0;
      }
    } catch {
      this.currentOffset = 0;
    }
    this.loaded = true;
  }

  current(): number {
    return this.currentOffset;
  }

  async persist(offset: number): Promise<void> {
    if (offset < 0) throw new Error("offset must be non-negative");
    this.currentOffset = offset;
    const data: OffsetFileContent = { offset, ts: Date.now() };
    await atomicWriteFile(this.stateDir.offsetFile, JSON.stringify(data), 0o600);
  }

  async flush(): Promise<void> {
    if (!this.loaded) return;
    await this.persist(this.currentOffset);
  }
}
