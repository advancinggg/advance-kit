// Boot orchestrator — wires M001 daemon-core + M002 telegram-client + M003 mcp-server-proxy
// + M006 admin-auth + M008 observability. See docs/modules/MODULE-001-daemon-core.md §2.7
// boot sequence and ~/.claude/plans/dev-tgcp-slice-infra.md Step 6 for the rationale of
// the ordering invariants enforced below.

import * as os from "node:os";
import { EventBus } from "./event-bus";
import { detectDeploymentMode } from "./deployment-mode";
import { realClock } from "./clock";
import { StateDirImpl, resolveStateDir } from "./state-dir";
import { acquireDaemonLock, releaseDaemonLock } from "./process-lock";
import { cleanupStaleSocket, installShutdownHandlers } from "./shutdown";
import { Watchdog } from "./watchdog";
import { E_HOMEDIR } from "./errors";
import { installObservability } from "../obs";
import { TelegramAPIClientImpl } from "../telegram/client";
import { PollingStatusImpl } from "../telegram/polling-status";
import { OffsetManager } from "../telegram/offset-manager";
import { PollingLoop } from "../telegram/polling-loop";
import { MCPDaemonAcceptor } from "../mcp/daemon-acceptor";
import { resolveAdminBoot } from "../auth/boot-resolver";

export async function main(): Promise<void> {
  const bootTs = Date.now();
  const env = process.env;
  const ppid = process.ppid;

  // L1: EventBus first; M008 subscribes immediately
  const eventBus = new EventBus();
  const deploymentMode = detectDeploymentMode(env, ppid);
  const clock = realClock();

  // L2: Install M008 observability with late-binding setter pattern.
  const obs = installObservability({
    eventBus,
    deploymentMode,
    clock,
    daemonPid: process.pid,
    daemonBootTs: bootTs,
  });

  // L3: Resolve state dir spec; construct stateDir.
  const homedir = os.homedir();
  if (!homedir) {
    process.stderr.write("daemon-core: os.homedir() empty — cannot resolve state dir\n");
    obs.drainAlertsToLogOnly();
    throw new E_HOMEDIR();
  }
  const stateDir = new StateDirImpl(resolveStateDir(env, homedir), eventBus);

  // L4: Initialize state dir (may emit `state_dir_perms_anomaly`; M008 buffers).
  await stateDir.initialize();

  // L5: M008 can now write logs to disk; buffered events flush.
  obs.setStateDir(stateDir);

  // L6: Acquire single-instance lock (may emit `lock_event: stale_takeover`).
  const lockHandle = await acquireDaemonLock(stateDir, eventBus);
  if (!lockHandle) {
    process.stderr.write("daemon-core: another daemon already running, exiting\n");
    obs.drainAlertsToLogOnly();
    process.exit(0);
  }

  // L7: Token validation.
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    process.stderr.write("daemon-core: TELEGRAM_BOT_TOKEN env var not set, exiting\n");
    obs.drainAlertsToLogOnly();
    await releaseDaemonLock(lockHandle).catch(() => undefined);
    process.exit(1);
  }

  // L8: Build pollingStatus + offsetManager BEFORE tgClient so tgClient's
  //     quarantine-aware sendMessage path doesn't NPE on a null pollingStatus.
  const pollingStatus = new PollingStatusImpl(clock, eventBus);
  const offsetManager = new OffsetManager(stateDir, eventBus);
  await offsetManager.load();

  // L9: Build TG client with pollingStatus already bound. Bind to M008 so
  //     AlertDispatcher can deliver alerts from here on.
  const apiBase = env.TELEGRAM_API_BASE && env.TELEGRAM_API_BASE.trim().length > 0
    ? env.TELEGRAM_API_BASE
    : "https://api.telegram.org";
  const tgClient = new TelegramAPIClientImpl({ token, eventBus, clock, pollingStatus, apiBase });
  obs.setTgClient(tgClient);

  // L10: Emit daemon_start.
  eventBus.emit("daemon_start", {
    pid: process.pid,
    boot_ts: bootTs,
    bun_version: Bun.version,
    deployment_mode: deploymentMode,
  });

  // L11: Cleanup any stale UDS socket left by prior unclean exit (M001-AC-21).
  await cleanupStaleSocket(stateDir.socketFile);

  // L12: Install shutdown handlers BEFORE Watchdog so requestShutdown callback target exists.
  const shutdownCtl = installShutdownHandlers({
    eventBus,
    lockHandle,
    stateDir,
    bootTs,
  });

  // L13: Polling loop.
  const polling = new PollingLoop({
    tgClient,
    eventBus,
    offsetManager,
    pollingStatus,
    clock,
  });
  polling.start();

  // L14: UDS acceptor.
  const mcpAcceptor = new MCPDaemonAcceptor({ eventBus, stateDir, clock });
  await mcpAcceptor.start();

  // L15: Admin-auth boot resolver (env / file / open-registration).
  await resolveAdminBoot({ stateDir, env, eventBus, deploymentMode, clock });

  // L16: Watchdog probe loop.
  const watchdog = new Watchdog({
    eventBus,
    clock,
    deploymentMode,
    bootPpid: ppid,
    getCurrentPpid: () => process.ppid,
    requestShutdown: (reason: string) => shutdownCtl.requestShutdown(reason, 1),
  });
  watchdog.start();

  // L17: main returns; daemon stays alive on the event loop.
}
