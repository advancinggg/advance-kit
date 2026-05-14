import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventBus } from "../../src/daemon/event-bus";
import { realClock } from "../../src/daemon/clock";
import { AttachmentJanitor } from "../../src/tools/attachment-janitor";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("MODULE-004-AC-15: AttachmentJanitor TTL sweep", () => {
  test("MODULE-004-T18 — sweepOnce unlinks files older than TTL hours; preserves fresh", async () => {
    const bus = new EventBus();
    const tmp = makeTmpStateDir(bus);
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const dir = tmp.stateDir.attachmentDir;
    const fresh = path.join(dir, "fresh.png");
    const stale1 = path.join(dir, "stale1.pdf");
    const stale2 = path.join(dir, "stale2.txt");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(stale1, "stale");
    fs.writeFileSync(stale2, "stale");
    // Backdate stale files by 7h (TTL default 6h)
    const sevenHoursAgo = (Date.now() - 7 * 3600 * 1000) / 1000;
    fs.utimesSync(stale1, sevenHoursAgo, sevenHoursAgo);
    fs.utimesSync(stale2, sevenHoursAgo, sevenHoursAgo);
    const j = new AttachmentJanitor({
      stateDir: tmp.stateDir,
      eventBus: bus,
      clock: realClock(),
      ttlHours: 6,
    });
    const r = j.sweepOnce();
    expect(r.unlinked).toBe(2);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale1)).toBe(false);
    expect(fs.existsSync(stale2)).toBe(false);
  });
});
