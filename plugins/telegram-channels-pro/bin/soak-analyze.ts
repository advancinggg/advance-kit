#!/usr/bin/env bun
/**
 * soak-analyze.ts — post-hoc analyzer for soak-monitor.sh JSONL output.
 *
 * Reads <samples-YYYYMMDD.jsonl> files and computes the soak verdict against
 * the M001-AC-15 / M001-AC-16 / REQ-017 / REQ-019 / REQ-021 acceptance bars:
 *
 *   - REQ-019 / M001-AC-15: zero zombies = no bun processes with STAT=R AND
 *     etime>1h AND pcpu>50%.
 *   - REQ-021 / M001-AC-16: stationary RSS<50MB P95, CPU<1% mean over the
 *     last 120 samples (excluding the first 30 min of warm-up).
 *   - REQ-017: ≥99% of 5-min windows had zero MCP disconnect events.
 *
 * Usage:
 *   bun run soak-analyze.ts <samples-dir>
 *   SOAK_OUT_DIR=/tmp/soak bun run soak-analyze.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Sample {
  ts: number;
  ts_iso: string;
  bun_procs: Array<{ pid: number; ppid: number; stat: string; etime: string; pcpu: number; rss: number; comm: string }>;
  mcp_sock: boolean;
  ctl_sock: boolean;
  counts: {
    inbound: number;
    quarantine_enter: number;
    quarantine_exit: number;
    session_connected: number;
    session_disconnected: number;
  };
}

function loadSamples(dir: string): Sample[] {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("samples-") && f.endsWith(".jsonl")).sort();
  const samples: Sample[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        samples.push(JSON.parse(line) as Sample);
      } catch {
        // skip malformed line
      }
    }
  }
  return samples.sort((a, b) => a.ts - b.ts);
}

function parseEtimeToSeconds(etime: string): number {
  // ps etime formats: SS, MM:SS, HH:MM:SS, DD-HH:MM:SS
  const dashSplit = etime.split("-");
  let days = 0;
  let rest = etime;
  if (dashSplit.length === 2) {
    days = Number(dashSplit[0]);
    rest = dashSplit[1]!;
  }
  const parts = rest.split(":").map(Number);
  let secs = 0;
  if (parts.length === 1) secs = parts[0]!;
  else if (parts.length === 2) secs = parts[0]! * 60 + parts[1]!;
  else if (parts.length === 3) secs = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return days * 86400 + secs;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function analyze(samples: Sample[]): void {
  if (samples.length === 0) {
    console.error("no samples found");
    process.exit(1);
  }
  const startTs = samples[0]!.ts;
  const endTs = samples[samples.length - 1]!.ts;
  const durationHours = (endTs - startTs) / 3600;
  console.log(`Soak window: ${samples[0]!.ts_iso} → ${samples[samples.length - 1]!.ts_iso} (${durationHours.toFixed(1)}h, ${samples.length} samples)`);

  // REQ-019 / M001-AC-15: zombie check
  let zombies: Array<{ ts: string; pid: number; etime: string; pcpu: number }> = [];
  for (const s of samples) {
    for (const p of s.bun_procs) {
      const etimeSec = parseEtimeToSeconds(p.etime);
      if (p.stat.startsWith("R") && etimeSec > 3600 && p.pcpu > 50) {
        zombies.push({ ts: s.ts_iso, pid: p.pid, etime: p.etime, pcpu: p.pcpu });
      }
    }
  }
  console.log(`\n=== REQ-019 / M001-AC-15: zero-zombie check ===`);
  if (zombies.length === 0) {
    console.log("PASS: no bun processes with STAT=R AND etime>1h AND CPU>50% observed");
  } else {
    console.log(`FAIL: ${zombies.length} zombie observations`);
    zombies.slice(0, 5).forEach((z) => console.log(`  ${z.ts} pid=${z.pid} etime=${z.etime} pcpu=${z.pcpu}`));
  }

  // REQ-021 / M001-AC-16: stationary RSS + CPU
  // Skip first 30 min of warm-up
  const warmupEnd = startTs + 30 * 60;
  const stationary = samples.filter((s) => s.ts >= warmupEnd);
  // Pick the daemon process: first bun process whose ppid is 1 (launchd) OR longest etime
  const daemonRss: number[] = [];
  const daemonCpu: number[] = [];
  for (const s of stationary) {
    if (s.bun_procs.length === 0) continue;
    // Prefer ppid=1 (launchd) else longest etime
    let daemon = s.bun_procs.find((p) => p.ppid === 1);
    if (!daemon) {
      daemon = [...s.bun_procs].sort((a, b) => parseEtimeToSeconds(b.etime) - parseEtimeToSeconds(a.etime))[0]!;
    }
    daemonRss.push(daemon.rss / 1024); // KB → MB
    daemonCpu.push(daemon.pcpu);
  }
  const rssP95 = percentile(daemonRss, 95);
  const cpuMean = mean(daemonCpu);
  console.log(`\n=== REQ-021 / M001-AC-16: stationary RSS + CPU ===`);
  console.log(`Stationary samples: ${daemonRss.length} (excluded first 30min warm-up)`);
  console.log(`RSS P95: ${rssP95.toFixed(1)} MB (target: < 50 MB) ${rssP95 < 50 ? "PASS" : "FAIL"}`);
  console.log(`CPU mean: ${cpuMean.toFixed(2)}% (target: < 1%) ${cpuMean < 1 ? "PASS" : "FAIL"}`);

  // REQ-017: 5-min windows zero MCP disconnect
  // Group samples into 5-min windows (300s each); count windows with any
  // session_disconnected or quarantine event change vs prior sample.
  const windowSize = 300;
  const windows: Array<{ start: number; disconnects: number; samples: number }> = [];
  let curWindow = { start: startTs, disconnects: 0, samples: 0 };
  let lastDisconnects = samples[0]!.counts.session_disconnected;
  for (const s of samples) {
    if (s.ts >= curWindow.start + windowSize) {
      windows.push(curWindow);
      curWindow = { start: curWindow.start + windowSize, disconnects: 0, samples: 0 };
    }
    const delta = s.counts.session_disconnected - lastDisconnects;
    if (delta > 0) curWindow.disconnects += delta;
    curWindow.samples += 1;
    lastDisconnects = s.counts.session_disconnected;
  }
  windows.push(curWindow);
  const cleanWindows = windows.filter((w) => w.disconnects === 0).length;
  const totalWindows = windows.length;
  const cleanRate = totalWindows > 0 ? (cleanWindows / totalWindows) * 100 : 0;
  console.log(`\n=== REQ-017: stability SLO (≥99% 5-min windows zero MCP disconnect) ===`);
  console.log(`Clean 5-min windows: ${cleanWindows}/${totalWindows} = ${cleanRate.toFixed(2)}%`);
  console.log(`SLO: ${cleanRate >= 99 ? "PASS" : "FAIL"}`);
  if (totalWindows < 864) {
    console.log(`  WARN: only ${totalWindows} windows observed; 72h soak target = 864 windows`);
  }

  // Inbound delta (REQ-018 sanity check — at least some traffic)
  const totalInbound = samples[samples.length - 1]!.counts.inbound - samples[0]!.counts.inbound;
  console.log(`\n=== Inbound traffic over soak window ===`);
  console.log(`Total inbound updates: ${totalInbound}`);

  // Final verdict
  console.log(`\n=== Verdict ===`);
  const overallPass =
    zombies.length === 0 &&
    rssP95 < 50 &&
    cpuMean < 1 &&
    cleanRate >= 99;
  console.log(overallPass ? "OVERALL: PASS" : "OVERALL: FAIL (one or more bars not met)");
  process.exit(overallPass ? 0 : 1);
}

const dir = process.argv[2] ?? process.env.SOAK_OUT_DIR ?? `${process.env.HOME}/soak-logs`;
if (!fs.existsSync(dir)) {
  console.error(`samples dir not found: ${dir}`);
  process.exit(1);
}
analyze(loadSamples(dir));
