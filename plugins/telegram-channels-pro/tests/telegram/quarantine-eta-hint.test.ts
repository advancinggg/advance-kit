import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventBus } from "../../src/daemon/event-bus";
import { EventCollector } from "../helpers/event-collector";

describe("MODULE-002-AC-32: eta_hint on quarantine_enter/quarantine_exit (REQ-045)", () => {
  test("MODULE-002-T32a — quarantine_enter payload accepts eta_hint and delivers it to subscribers", () => {
    const eb = new EventBus();
    const collector = new EventCollector(eb);
    eb.emit("quarantine_enter", {
      reason: "fatal_window_threshold",
      count_in_window: 5,
      window_ms: 60_000,
      eta_hint: 60,
    });
    const enters = collector.byType("quarantine_enter");
    expect(enters.length).toBe(1);
    const payload = enters[0]!.payload as { eta_hint?: number; reason: string };
    expect(payload.eta_hint).toBe(60);
    expect(payload.reason).toBe("fatal_window_threshold");
    collector.stop();
  });

  test("MODULE-002-T32b — polling-loop.ts source emits quarantine_enter with eta_hint on probe-fail-restart-cooldown", () => {
    // Source-contract verification: re-emit of quarantine_enter on probe-fail must include eta_hint.
    // This complements the synthetic-emit test above by guarding the production call site.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/telegram/polling-loop.ts"),
      "utf8",
    );
    // Must contain a probe-fail re-emit (any reason matching "probe_*_restart_cooldown") that includes eta_hint.
    expect(src).toContain('"probe_fatal_restart_cooldown"');
    expect(src).toContain('"probe_non_ok_restart_cooldown"');
    // The eta_hint computation must be present in the probe-fail branch.
    expect(src).toContain("Math.ceil(this.cfg.quarantineCooldownMs / 1000)");
  });

  test("MODULE-002-T32c — quarantine_exit payload accepts eta_hint: 0 and delivers it", () => {
    const eb = new EventBus();
    const collector = new EventCollector(eb);
    eb.emit("quarantine_exit", { recovered_after_ms: 65_000, eta_hint: 0 });
    const exits = collector.byType("quarantine_exit");
    expect(exits.length).toBe(1);
    const payload = exits[0]!.payload as { eta_hint?: number; recovered_after_ms: number };
    expect(payload.eta_hint).toBe(0);
    expect(payload.recovered_after_ms).toBe(65_000);
    collector.stop();
  });

  test("MODULE-002-T32 — polling-loop.ts emits quarantine_exit with eta_hint: 0 at the production call site", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/telegram/polling-loop.ts"),
      "utf8",
    );
    // The quarantine_exit emit in polling-loop.ts must carry eta_hint: 0.
    // Match the emit block; allow whitespace variations.
    const exitEmitPattern =
      /eventBus\.emit\("quarantine_exit",\s*\{\s*[^}]*eta_hint:\s*0/m;
    expect(exitEmitPattern.test(src)).toBe(true);
  });

  test("MODULE-002-T32 — polling-loop.ts emits quarantine_enter with eta_hint on fatal-window trip", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/telegram/polling-loop.ts"),
      "utf8",
    );
    // The fatal-window-trip emit must include eta_hint computed from quarantineCooldownMs.
    const enterEmitPattern =
      /"quarantine_enter",\s*\{[^}]*reason:\s*"fatal_window_threshold"[^}]*eta_hint:\s*Math\.ceil/m;
    expect(enterEmitPattern.test(src)).toBe(true);
  });
});
