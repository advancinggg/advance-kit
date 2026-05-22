// Boot orchestrator — wires M001 daemon-core + M002 telegram-client + M003 mcp-server-proxy
// + M004 mcp-tools + M005 routing + M006 admin-auth + M007 deployment (control socket) +
// M008 observability. See docs/modules/MODULE-001-daemon-core.md §2.7 boot sequence and
// ~/.claude/plans/dev-tgcp-slice-orchestration.md §4.1 for the rationale of the
// ordering invariants enforced below.

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
import { TelegramAPIClientImpl, QUARANTINE_QUEUE_CAP } from "../telegram/client";
import { PollingStatusImpl } from "../telegram/polling-status";
import { OffsetManager } from "../telegram/offset-manager";
import { PollingLoop } from "../telegram/polling-loop";
import { OutboundReplayQueue } from "../telegram/outbound-replay-queue";
import { ChatTypeCacheImpl } from "../telegram/chat-type-cache";
import { MCPDaemonAcceptor } from "../mcp/daemon-acceptor";
import { resolveAdminBoot } from "../auth/boot-resolver";
import { AdminStateResetImpl } from "../auth/state-reset";
import { AdminChatRegistry } from "../routing/admin-chat-registry";
import { installToolHandlers } from "../tools";
import { installRouting } from "../routing";
import { WaitForResetHandshakeHandler } from "../routing/wait-for-reset-handshake";
import { ControlSocket } from "../deployment/control-socket";

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

  // L8a (Slice 2 / CCD-20): construct AdminChatRegistry eagerly with env value
  // BEFORE mcpAcceptor.start() at L14 → eliminates the env-parse race for
  // request_approval issued in the first MCP session.
  const adminChatRegistry = new AdminChatRegistry(env.TG_ADMIN_CHAT_ID);

  // L8c (v1.1.0 — REQ-037): construct OutboundReplayQueue BEFORE tgClient so the client
  // can inject it via cfg. Production wiring with EventBus (drain emits
  // `quarantine_replay_resolved` events) + clock (drain reads `replayed_at` for the event
  // payload schema per CONTRACT-003).
  const outboundReplayQueue = new OutboundReplayQueue({
    capacity: QUARANTINE_QUEUE_CAP,
    eventBus,
    clock,
  });

  // L9: Build TG client with pollingStatus + outboundReplayQueue already bound.
  const apiBase = env.TELEGRAM_API_BASE && env.TELEGRAM_API_BASE.trim().length > 0
    ? env.TELEGRAM_API_BASE
    : "https://api.telegram.org";
  const tgClient = new TelegramAPIClientImpl({
    token,
    eventBus,
    clock,
    pollingStatus,
    apiBase,
    outboundReplayQueue,
  });

  // L9c (v1.1.0 — REQ-035): construct ChatTypeCache after tgClient so it can inject the
  // client for cold-start lazy-fetch via CONTRACT-004 getChat.
  const chatTypeCache = new ChatTypeCacheImpl(tgClient, clock, eventBus);

  // L9a (Slice 2 / CCD-10): bind AlertDispatcher to current admin chat (env-bootstrapped
  // value if set, else 0 placeholder), AND subscribe AlertDispatcher to live updates
  // from AdminChatRegistry. The subscribe-fires-current-value pattern keeps the
  // initial sync atomic with subscription.
  obs.setTgClient(tgClient, adminChatRegistry.get() ?? 0);
  adminChatRegistry.subscribe((chatId) => {
    obs.setAdminChat(chatId ?? 0);
  });

  // L10: Emit daemon_start.
  eventBus.emit("daemon_start", {
    pid: process.pid,
    boot_ts: bootTs,
    bun_version: Bun.version,
    deployment_mode: deploymentMode,
  });

  // L11: Cleanup any stale UDS sockets (MCP + control) left by prior unclean exit.
  await cleanupStaleSocket(stateDir.socketFile);
  await cleanupStaleSocket(stateDir.controlSocketFile);

  // L12: Install shutdown handlers BEFORE Watchdog so requestShutdown callback target exists.
  const shutdownCtl = installShutdownHandlers({
    eventBus,
    lockHandle,
    stateDir,
    bootTs,
  });

  // L13: Polling loop. v1.1.0 — REQ-037: inject outboundReplayQueue so probe-success
  // branch can drain on quarantine_exit per M002 §1.4.5b (inline, NOT via self-subscription).
  const polling = new PollingLoop({
    tgClient,
    eventBus,
    offsetManager,
    pollingStatus,
    clock,
    outboundReplayQueue,
  });
  polling.start();

  // L15 (v10 REORDER — was L15 / now BEFORE L14): Admin-auth boot resolver must run
  // BEFORE L14b WaitForResetHandshakeHandler so registrationGate is available.
  const adminCtx = await resolveAdminBoot({ stateDir, env, eventBus, deploymentMode, clock });

  // L14: UDS acceptor (MCP socket for claude sessions). v10: split construct + start so
  // L14b can register the wait-for-reset handshake subscriber BEFORE start() admits any
  // session_connected. Closes the REQ-047 boot-race (round 8 Codex C1 finding).
  const mcpAcceptor = new MCPDaemonAcceptor({ eventBus, stateDir, clock });

  // L14b (v1.1.0 — REQ-047 stream c): install WaitForResetHandshakeHandler BEFORE
  // mcpAcceptor.start(). Handshake subscribes to session_connected and disconnects with
  // the literal "registration timed out; run reset-admin to retry" hint when M006 reports
  // waiting_for_reset state.
  const waitForResetHandshake = new WaitForResetHandshakeHandler({
    eventBus,
    registrationGate: adminCtx.registrationGate,
    acceptor: mcpAcceptor,
  });
  waitForResetHandshake.install();

  // L14a (Slice 2): wire 5 MCP tool handlers + PendingApprovalRegistry + janitor + snapshot emitter.
  // v1.1.0 — REQ-035: pass chatTypeCache for outbound DiD gate on 4 outbound tools.
  const toolsCtx = installToolHandlers({
    acceptor: mcpAcceptor,
    tg: tgClient,
    apiBase,
    token,
    pollingStatus,
    eventBus,
    stateDir,
    clock,
    adminChatRegistry,
    chatTypeCache,
  });

  // L14 finish (v10): start the acceptor NOW that the handshake handler is subscribed.
  await mcpAcceptor.start();

  // L15a (Slice 2 / CCD-6): construct AdminStateReset; bind admin source on StatusReporter.
  const adminStateReset = new AdminStateResetImpl(stateDir, adminCtx.allowlist, eventBus);
  obs.getStatusReporter().setAdminSource(adminCtx.allowlist.source());

  // L15b (Slice 2): wire M005 routing. v1.1.0 — REQ-035 chatTypeCache for primeCache;
  // pass the already-installed waitForResetHandshake so routing/index.ts doesn't re-install.
  const routingCtx = installRouting({
    acceptor: mcpAcceptor,
    tg: tgClient,
    eventBus,
    clock,
    adminAllowlist: adminCtx.allowlist,
    registrationGate: adminCtx.registrationGate,
    statusReporter: obs.getStatusReporter(),
    pendingRegistry: toolsCtx.getPendingRegistry(),
    adminChatRegistry,
    chatTypeCache,
    waitForResetHandshake,
  });

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

  // L17 (Slice 2): ControlSocket — daemon-side handler for status / reset_admin frames.
  const controlSocket = new ControlSocket({
    stateDir,
    eventBus,
    clock,
    deploymentMode,
    getSnapshot: () => obs.getStatusReporter().getSnapshot(),
    resetAdmin: () => {
      const result = adminStateReset.resetAdmin();
      adminCtx.registrationGate.forceReopenForReset();
      return {
        cleared: result.cleared,
        prior_admin_hash: result.prior_admin_hash,
        deployment_mode: deploymentMode,
        daemon_pid: process.pid,
      };
    },
  });
  await controlSocket.start();

  // Hand-off references to shutdown for cleanup wiring (best-effort: subscribe to
  // daemon_stop and dispose).
  eventBus.on("daemon_stop", () => {
    void controlSocket.stop();
    routingCtx.dispose();
    toolsCtx.dispose();
  });

  // Suppress unused warnings — these references are held by the daemon's runtime closure.
  void watchdog;
  void polling;

  // L18: main returns; daemon stays alive on the event loop.
}
