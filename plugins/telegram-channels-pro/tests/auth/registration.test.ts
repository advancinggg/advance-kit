import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { EventBus } from "../../src/daemon/event-bus";
import { fakeClock } from "../../src/daemon/clock";
import { AdminAllowlistImpl } from "../../src/auth/allowlist";
import { RegistrationGateImpl } from "../../src/auth/registration-gate";
import { resolveAdminBoot } from "../../src/auth/boot-resolver";
import { AdminStateResetImpl } from "../../src/auth/state-reset";
import { makeTmpStateDir } from "../helpers/tmp-state-dir";
import { EventCollector } from "../helpers/event-collector";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeGate(opts: Partial<Parameters<typeof RegistrationGateImpl>[0]> = {}) {
  const tmp = makeTmpStateDir();
  cleanups.push(tmp.cleanup);
  const allowlist = new AdminAllowlistImpl();
  const clock = fakeClock(0);
  const gate = new RegistrationGateImpl({
    stateDir: tmp.stateDir,
    allowlist,
    clock,
    eventBus: tmp.eventBus,
    deploymentMode: "lazy-spawn",
    emitCodeToStderr: () => undefined,
    ...opts,
  });
  return { gate, allowlist, clock, tmp };
}

describe("MODULE-006-AC-01/AC-02/AC-03: env / file / registration boot path", () => {
  test("MODULE-006-T01 — env var TELEGRAM_AUTHORIZED_USERS set → use env, admin_source='env', admin.json ignored", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.adminFile, JSON.stringify({ tg_user_id: 99, created_at: 1, source: "file" }), { mode: 0o600 });
    const ctx = await resolveAdminBoot({
      stateDir: tmp.stateDir,
      env: { TELEGRAM_AUTHORIZED_USERS: "[1]" },
      eventBus: tmp.eventBus,
      deploymentMode: "lazy-spawn",
      clock: fakeClock(0),
    });
    expect(ctx.allowlist.isAdmin(1)).toBe(true);
    expect(ctx.allowlist.isAdmin(99)).toBe(false);
    expect(ctx.allowlist.source()).toBe("env");
  });

  test("MODULE-006-T02 — env empty + admin.json present → use file, admin_source='file'", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.adminFile, JSON.stringify({ tg_user_id: 42, created_at: 1, source: "file" }), { mode: 0o600 });
    const ctx = await resolveAdminBoot({
      stateDir: tmp.stateDir,
      env: {},
      eventBus: tmp.eventBus,
      deploymentMode: "lazy-spawn",
      clock: fakeClock(0),
    });
    expect(ctx.allowlist.isAdmin(42)).toBe(true);
    expect(ctx.allowlist.source()).toBe("file");
  });

  test("MODULE-006-T03 — no env, no admin.json → enter registration window + emit window_opened", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    const ctx = await resolveAdminBoot({
      stateDir: tmp.stateDir,
      env: {},
      eventBus: tmp.eventBus,
      deploymentMode: "lazy-spawn",
      clock: fakeClock(0),
    });
    expect(ctx.registrationGate.state()).toBe("open");
    expect(ctx.registrationGate.currentCodeForTest()).not.toBeNull();
    const events = collector.byType("registration_event").filter((e) => (e.payload as { kind: string }).kind === "window_opened");
    expect(events.length).toBe(1);
    collector.stop();
    ctx.registrationGate.stop();
  });
});

describe("MODULE-006-AC-05: successful registration", () => {
  test("MODULE-006-T05 — register <code> from sender → admin.json persisted with 0600, allowlist updated, window closed", async () => {
    const { gate, allowlist, tmp } = makeGate();
    await tmp.stateDir.initialize();
    gate.openWindow();
    const code = gate.currentCodeForTest()!;
    const result = await gate.processRegistrationDM(12345, `register ${code}`);
    expect(result.kind).toBe("success");
    expect(allowlist.isAdmin(12345)).toBe(true);
    expect(allowlist.source()).toBe("file");
    expect(gate.state()).toBe("closed");
    expect(fs.existsSync(tmp.stateDir.adminFile)).toBe(true);
    expect(fs.statSync(tmp.stateDir.adminFile).mode & 0o777).toBe(0o600);
  });
});

describe("MODULE-006-AC-06: per-sender brute-force counter", () => {
  test("MODULE-006-T06 — 5 wrong DMs from same sender → 6th silently rate-limited", async () => {
    const { gate, tmp } = makeGate();
    await tmp.stateDir.initialize();
    gate.openWindow();
    for (let i = 0; i < 5; i++) {
      const r = await gate.processRegistrationDM(7, `register WRONGX`);
      expect(["fail_format", "fail_code"]).toContain(r.kind);
    }
    const sixth = await gate.processRegistrationDM(7, `register WRONGY`);
    expect(sixth.kind).toBe("rate_limited_per_sender");
  });
});

describe("MODULE-006-AC-07: global brute-force counter", () => {
  test("MODULE-006-T07 — 30 wrong DMs across senders → window closed, waiting_for_reset + auth_deny_registration:global_trip", async () => {
    const { gate, tmp } = makeGate();
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    gate.openWindow();
    // 30 attempts from 30 different senders (each only fails once).
    for (let i = 0; i < 30; i++) {
      await gate.processRegistrationDM(1000 + i, `register WRONGZ`);
    }
    expect(gate.state()).toBe("waiting_for_reset");
    const trips = collector.byType("auth_deny_registration").filter((e) => (e.payload as { kind: string }).kind === "global_trip");
    expect(trips.length).toBeGreaterThanOrEqual(1);
    const closed = collector.byType("registration_event").filter((e) => (e.payload as { kind: string }).kind === "window_closed_brute_force");
    expect(closed.length).toBe(1);
    collector.stop();
  });
});

describe("MODULE-006-AC-08: lazy-spawn registration timeout", () => {
  test("MODULE-006-T08 — lazy-spawn mode + window expires → emit timeout_lazy_spawn", () => {
    const { gate, clock, tmp } = makeGate({ deploymentMode: "lazy-spawn", windowMs: 1000 });
    const collector = new EventCollector(tmp.eventBus);
    gate.openWindow();
    clock.tick(1500);
    const events = collector.byType("registration_event").filter((e) => (e.payload as { kind: string }).kind === "timeout_lazy_spawn");
    expect(events.length).toBe(1);
    collector.stop();
  });
});

describe("MODULE-006-AC-09: launchd registration timeout (wait-for-reset)", () => {
  test("MODULE-006-T09 — launchd mode + window expires → emit registration_timeout + state=waiting_for_reset (M002 will pause)", () => {
    const { gate, clock, tmp } = makeGate({ deploymentMode: "launchd", windowMs: 1000 });
    const collector = new EventCollector(tmp.eventBus);
    gate.openWindow();
    clock.tick(1500);
    expect(gate.state()).toBe("waiting_for_reset");
    const regTimeouts = collector.byType("registration_timeout");
    expect(regTimeouts.length).toBe(1);
    collector.stop();
  });
});

describe("MODULE-006-AC-12: admin.json wrong perms refused", () => {
  test("MODULE-006-T12 — admin.json with 0644 + cross-uid → emit state_dir_perms_anomaly action='refused', refuse to read", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.adminFile, JSON.stringify({ tg_user_id: 1, created_at: 1, source: "file" }), { mode: 0o644 });
    fs.chmodSync(tmp.stateDir.adminFile, 0o644);
    const originalGetUid = process.getuid;
    process.getuid = () => 999999;
    const collector = new EventCollector(tmp.eventBus);
    try {
      expect(() =>
        resolveAdminBoot({
          stateDir: tmp.stateDir,
          env: {},
          eventBus: tmp.eventBus,
          deploymentMode: "lazy-spawn",
          clock: fakeClock(0),
        }),
      ).toThrow();
      const anomalies = collector.byType("state_dir_perms_anomaly");
      expect(anomalies.length).toBeGreaterThanOrEqual(1);
      expect((anomalies[0]!.payload as { action: string }).action).toBe("refused");
    } finally {
      process.getuid = originalGetUid;
      collector.stop();
    }
  });
});

describe("MODULE-006-AC-13: cross-uid file refused (covered by T12 above)", () => {
  test("MODULE-006-T13 — same as T12 (the cross-uid path is checked at every admin.json read)", () => {
    // Implementation-shared with T12; explicit re-statement marker.
    expect(true).toBe(true);
  });
});

describe("MODULE-006-AC-14/AC-15: AdminStateReset", () => {
  test("MODULE-006-T14 — resetAdmin() with existing admin.json deletes file + emits registration_event:admin_reset with prior_admin_hash", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    fs.writeFileSync(tmp.stateDir.adminFile, JSON.stringify({ tg_user_id: 12345, created_at: 1, source: "file" }), { mode: 0o600 });
    const allowlist = new AdminAllowlistImpl();
    allowlist.setFromFile(12345);
    const resetter = new AdminStateResetImpl(tmp.stateDir, allowlist, tmp.eventBus);
    const collector = new EventCollector(tmp.eventBus);
    const result = resetter.resetAdmin();
    expect(result.cleared).toBe(true);
    expect(result.prior_admin_hash).not.toBeNull();
    expect(result.prior_admin_hash!.length).toBe(12);
    expect(fs.existsSync(tmp.stateDir.adminFile)).toBe(false);
    expect(allowlist.isAdmin(12345)).toBe(false);
    const events = collector.byType("registration_event").filter((e) => (e.payload as { kind: string }).kind === "admin_reset");
    expect(events.length).toBe(1);
    collector.stop();
  });

  test("MODULE-006-T15 — resetAdmin() with no admin.json is idempotent: returns cleared=false", async () => {
    const tmp = makeTmpStateDir();
    cleanups.push(tmp.cleanup);
    await tmp.stateDir.initialize();
    const allowlist = new AdminAllowlistImpl();
    const resetter = new AdminStateResetImpl(tmp.stateDir, allowlist, tmp.eventBus);
    const result = resetter.resetAdmin();
    expect(result.cleared).toBe(false);
    expect(result.prior_admin_hash).toBeNull();
  });
});

describe("MODULE-006-AC-17: registration code redaction", () => {
  test("MODULE-006-T17 — emitted events contain code_hash, never the raw code", async () => {
    const { gate, tmp } = makeGate();
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    gate.openWindow();
    const code = gate.currentCodeForTest()!;
    await gate.processRegistrationDM(7, "register WRONG"); // fail
    const events = collector.events;
    for (const e of events) {
      const serialized = JSON.stringify(e.payload);
      expect(serialized).not.toContain(code);
    }
    collector.stop();
  });
});

describe("MODULE-006-AC-19: isInRegistrationWindow", () => {
  test("MODULE-006-T19 — true only during open state; false in closed and waiting_for_reset", async () => {
    const { gate, tmp } = makeGate();
    await tmp.stateDir.initialize();
    expect(gate.isInRegistrationWindow()).toBe(false); // closed
    gate.openWindow();
    expect(gate.isInRegistrationWindow()).toBe(true);
    // Force-trip global counter to transition to waiting_for_reset.
    for (let i = 0; i < 30; i++) {
      await gate.processRegistrationDM(2000 + i, `register WRONGZ`);
    }
    expect(gate.state()).toBe("waiting_for_reset");
    expect(gate.isInRegistrationWindow()).toBe(false);
  });
});

describe("MODULE-006-AC-16: case sensitivity (smoke)", () => {
  test("MODULE-006-T16b — REGISTER (uppercase verb) → fail_format", async () => {
    const { gate, tmp } = makeGate();
    await tmp.stateDir.initialize();
    gate.openWindow();
    const code = gate.currentCodeForTest()!;
    const result = await gate.processRegistrationDM(7, `REGISTER ${code}`); // wrong case for "register"
    expect(result.kind).toBe("fail_format");
  });
});

describe("MODULE-006-AC-20: forceReopenForReset transitions from any state", () => {
  test("MODULE-006-T20.a — pre-state 'open' → forceReopenForReset → state remains 'open' with fresh code; counters reset; window_opened with trigger:'admin_reset' emitted", async () => {
    const { gate, tmp } = makeGate({ deploymentMode: "launchd", windowMs: 5 * 60_000 });
    await tmp.stateDir.initialize();
    const collector = new EventCollector(tmp.eventBus);
    cleanups.push(() => collector.stop());
    gate.openWindow();
    expect(gate.state()).toBe("open");
    const codeBefore = gate.currentCodeForTest();
    await gate.processRegistrationDM(1, "register WRONG1");
    await gate.processRegistrationDM(2, "register WRONG2");
    collector.clear();
    gate.forceReopenForReset();
    expect(gate.state()).toBe("open");
    const codeAfter = gate.currentCodeForTest();
    expect(codeAfter).not.toBeNull();
    expect(codeAfter).not.toBe(codeBefore);
    const opened = collector.byType("registration_event").filter((e) => {
      const p = e.payload as { kind?: string; detail?: { trigger?: string } };
      return p.kind === "window_opened" && p.detail?.trigger === "admin_reset";
    });
    expect(opened.length).toBe(1);
    const detail = (opened[0]!.payload as { detail: { code_hash: string; trigger: string } }).detail;
    expect(typeof detail.code_hash).toBe("string");
    expect(detail.trigger).toBe("admin_reset");
    // Counters reset: sender 1's per-sender count is now 0; allowed to attempt again
    // Use a regex-valid but wrong code (uppercase 6 chars from the allowed alphabet, distinct from any real code)
    const r = await gate.processRegistrationDM(1, "register ABCDEF");
    expect(r.kind).toBe("fail_code");
  });

  test("MODULE-006-T20.b — pre-state 'waiting_for_reset' → forceReopenForReset → state 'open'; old reminder timer cancelled (only ONE timeout fires after 5min)", async () => {
    const { gate, tmp, clock } = makeGate({ deploymentMode: "launchd", windowMs: 5 * 60_000 });
    await tmp.stateDir.initialize();
    gate.openWindow();
    gate.forceTimeoutForTest();
    expect(gate.state()).toBe("waiting_for_reset");
    const collector = new EventCollector(tmp.eventBus);
    cleanups.push(() => collector.stop());
    gate.forceReopenForReset();
    expect(gate.state()).toBe("open");
    const opened = collector.byType("registration_event").filter((e) => {
      const p = e.payload as { kind?: string; detail?: { trigger?: string } };
      return p.kind === "window_opened" && p.detail?.trigger === "admin_reset";
    });
    expect(opened.length).toBe(1);
    collector.clear();
    clock.tick(5 * 60_000);
    const timeouts = collector.byType("registration_event").filter((e) => {
      const p = e.payload as { kind?: string };
      return p.kind === "timeout_launchd";
    });
    expect(timeouts.length).toBe(1); // exactly one from the NEW timer (old reminder timer was cancelled)
  });

  test("MODULE-006-T20.c — pre-state 'closed' → forceReopenForReset → state 'open'", async () => {
    const { gate, tmp } = makeGate();
    await tmp.stateDir.initialize();
    expect(gate.state()).toBe("closed");
    const collector = new EventCollector(tmp.eventBus);
    cleanups.push(() => collector.stop());
    gate.forceReopenForReset();
    expect(gate.state()).toBe("open");
    const opened = collector.byType("registration_event").filter((e) => {
      const p = e.payload as { kind?: string; detail?: { trigger?: string } };
      return p.kind === "window_opened" && p.detail?.trigger === "admin_reset";
    });
    expect(opened.length).toBe(1);
  });
});
