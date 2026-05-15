import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const PLUGIN_DIR = path.resolve(__dirname, "../..");
const ANALYZER = path.join(PLUGIN_DIR, "bin/soak-analyze.ts");

function mkSoakDir(samplesByDay: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `soak-test-${randomBytes(2).toString("hex")}-`));
  for (const [day, lines] of Object.entries(samplesByDay)) {
    fs.writeFileSync(path.join(dir, `samples-${day}.jsonl`), lines.join("\n") + "\n");
  }
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeSample(opts: {
  ts: number;
  rss?: number;
  pcpu?: number;
  etime?: string;
  stat?: string;
  disconnects?: number;
}): string {
  const sample = {
    ts: opts.ts,
    ts_iso: new Date(opts.ts * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    bun_procs: [
      {
        pid: 100,
        ppid: 1,
        stat: opts.stat ?? "S",
        etime: opts.etime ?? "01:00:00",
        pcpu: opts.pcpu ?? 0.5,
        rss: (opts.rss ?? 30) * 1024,
        comm: "bun",
      },
    ],
    mcp_sock: true,
    ctl_sock: true,
    counts: {
      inbound: 100,
      quarantine_enter: 0,
      quarantine_exit: 0,
      session_connected: 1,
      session_disconnected: opts.disconnects ?? 0,
    },
  };
  return JSON.stringify(sample);
}

function runAnalyzer(dir: string): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", ANALYZER, dir],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    code: proc.exitCode ?? -1,
  };
}

describe("soak-analyze: synthetic-data smoke tests", () => {
  test("clean soak (RSS 30MB, CPU 0.5%, no disconnects) → OVERALL: PASS", () => {
    const start = 1700000000;
    // 200 samples, 60s apart = 200 minutes (3.3h) — enough for stationary window
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(makeSample({ ts: start + i * 60, rss: 30, pcpu: 0.5 }));
    }
    const dir = mkSoakDir({ "20251015": lines });
    const r = runAnalyzer(dir);
    expect(r.stdout).toContain("PASS: no bun processes");
    expect(r.stdout).toContain("RSS P95");
    expect(r.stdout).toContain("PASS");
    expect(r.stdout).toContain("OVERALL: PASS");
    expect(r.code).toBe(0);
  });

  test("RSS climb past 50MB → RSS check FAIL → OVERALL: FAIL", () => {
    const start = 1700000000;
    const lines: string[] = [];
    // 200 samples; warm-up 30 → start at sample 30; rss grows to 60MB
    for (let i = 0; i < 200; i++) {
      const rss = 30 + i * 0.2; // grows from 30 to 70 MB
      lines.push(makeSample({ ts: start + i * 60, rss, pcpu: 0.5 }));
    }
    const dir = mkSoakDir({ "20251015": lines });
    const r = runAnalyzer(dir);
    expect(r.stdout).toContain("FAIL");
    expect(r.stdout).toContain("OVERALL: FAIL");
    expect(r.code).toBe(1);
  });

  test("zombie process (STAT=R, etime>1h, CPU>50%) → zero-zombie FAIL", () => {
    const start = 1700000000;
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      // Inject a zombie at sample 100
      const stat = i === 100 ? "R" : "S";
      const pcpu = i === 100 ? 80 : 0.5;
      const etime = i === 100 ? "02:00:00" : "01:00:00";
      lines.push(makeSample({ ts: start + i * 60, rss: 30, pcpu, stat, etime }));
    }
    const dir = mkSoakDir({ "20251015": lines });
    const r = runAnalyzer(dir);
    expect(r.stdout).toContain("FAIL: 1 zombie observations");
    expect(r.stdout).toContain("OVERALL: FAIL");
    expect(r.code).toBe(1);
  });

  test("frequent disconnects → SLO < 99% → FAIL", () => {
    const start = 1700000000;
    const lines: string[] = [];
    // 200 samples; inject session_disconnected count increment every 10 samples
    let disc = 0;
    for (let i = 0; i < 200; i++) {
      if (i % 10 === 0 && i > 0) disc += 1;
      lines.push(makeSample({ ts: start + i * 60, rss: 30, pcpu: 0.5, disconnects: disc }));
    }
    const dir = mkSoakDir({ "20251015": lines });
    const r = runAnalyzer(dir);
    // 5-min windows: 200 min / 5 = 40 windows; 20 disconnects spread across windows
    expect(r.stdout).toContain("Clean 5-min windows");
    expect(r.stdout).toContain("OVERALL: FAIL");
  });
});
