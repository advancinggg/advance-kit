import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock, TimerHandle } from "../daemon/clock";

export interface JsonLogEntry {
  ts: number;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  event_type: string;
  [key: string]: unknown;
}

export interface JsonLoggerConfig {
  logDir: string;
  clock: Clock;
  maxFileBytes?: number;
  retentionDays?: number;
  /** Override file format for tests; default `daemon-YYYYMMDD.jsonl`. */
  fileNameForDate?: (yyyymmdd: string) => string;
  /** Run janitor immediately (test convenience). */
  immediateJanitor?: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const JANITOR_INTERVAL_MS = 24 * 60 * 60_000;

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export class JsonLogger {
  private cfg: Required<JsonLoggerConfig>;
  private currentFilePath = "";
  private currentDate = "";
  private currentSize = 0;
  private rollSuffix = 0;
  private janitorTimer: TimerHandle | null = null;
  /** Last rollover info for tests. */
  public lastRotation: { oldFile: string; newFile: string } | null = null;

  constructor(cfg: JsonLoggerConfig) {
    this.cfg = {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      retentionDays: DEFAULT_RETENTION_DAYS,
      fileNameForDate: (yyyymmdd: string) => `daemon-${yyyymmdd}.jsonl`,
      immediateJanitor: false,
      ...cfg,
    };
    this.scheduleJanitor();
    if (this.cfg.immediateJanitor) this.runJanitor();
  }

  start(): void {
    // initialize current file path
    this.refreshCurrentFile();
  }

  append(entry: JsonLogEntry): void {
    this.refreshCurrentFile();
    const line = JSON.stringify(entry) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.currentSize + lineBytes > this.cfg.maxFileBytes) {
      this.rollSize();
    }
    fs.appendFileSync(this.currentFilePath, line, { mode: 0o600 });
    this.currentSize += lineBytes;
    try {
      // Ensure mode bits stay at 0o600 even when filesystem retains umask.
      fs.chmodSync(this.currentFilePath, 0o600);
    } catch {
      /* ignore */
    }
  }

  /** Synchronous appendBatch for the emergency drainAlertsToLogOnly exit-path. */
  appendBatchSync(entries: JsonLogEntry[]): void {
    for (const e of entries) this.append(e);
  }

  private refreshCurrentFile(): void {
    const today = formatDate(new Date(this.cfg.clock.now()));
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.rollSuffix = 0;
      this.currentFilePath = path.join(this.cfg.logDir, this.cfg.fileNameForDate(today));
      this.currentSize = fs.existsSync(this.currentFilePath) ? fs.statSync(this.currentFilePath).size : 0;
    }
  }

  private rollSize(): void {
    const oldFile = this.currentFilePath;
    this.rollSuffix += 1;
    const today = this.currentDate;
    this.currentFilePath = path.join(this.cfg.logDir, `${this.cfg.fileNameForDate(today).replace(/\.jsonl$/, "")}-${this.rollSuffix}.jsonl`);
    this.currentSize = 0;
    this.lastRotation = { oldFile, newFile: this.currentFilePath };
  }

  private scheduleJanitor(): void {
    this.janitorTimer = this.cfg.clock.setInterval(() => this.runJanitor(), JANITOR_INTERVAL_MS);
  }

  runJanitor(): { unlinkedCount: number; oldestDate: string | null } {
    const cutoffMs = this.cfg.clock.now() - this.cfg.retentionDays * 24 * 60 * 60_000;
    let unlinkedCount = 0;
    let oldestDate: string | null = null;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.cfg.logDir, { withFileTypes: true });
    } catch {
      return { unlinkedCount, oldestDate };
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/^daemon-\d{8}(?:-\d+)?\.jsonl$/.test(ent.name)) continue;
      const full = path.join(this.cfg.logDir, ent.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) {
        try {
          fs.unlinkSync(full);
          unlinkedCount += 1;
        } catch {
          /* ignore */
        }
        const datePart = ent.name.slice(7, 15);
        if (oldestDate === null || datePart < oldestDate) oldestDate = datePart;
      }
    }
    return { unlinkedCount, oldestDate };
  }

  stop(): void {
    if (this.janitorTimer) {
      this.janitorTimer.cancel();
      this.janitorTimer = null;
    }
  }

  getCurrentFile(): string {
    return this.currentFilePath;
  }
}
