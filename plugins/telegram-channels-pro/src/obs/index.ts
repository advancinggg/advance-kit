import type { Clock } from "../daemon/clock";
import type { DeploymentMode } from "../daemon/deployment-mode";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";
import type { TelegramAPIClient } from "../telegram/client";
import { JsonLogger } from "./json-logger";
import { AlertDispatcher } from "./alert-dispatcher";
import { StatusReporter } from "./status-reporter";
import { Subscriber } from "./subscriber";
import { MeasurementHelper } from "./measurement-helper";

export interface ObservabilityCtx {
  setStateDir(sd: StateDir): void;
  setTgClient(tg: TelegramAPIClient, adminChatId?: number): void;
  getStatusReporter(): StatusReporter;
  getLoggerForTest(): JsonLogger;
  getAlertDispatcherForTest(): AlertDispatcher;
  drainAlertsToLogOnly(): number;
  dispose(): void;
}

export interface InstallObservabilityArgs {
  eventBus: EventBus;
  deploymentMode: DeploymentMode;
  clock: Clock;
  daemonPid: number;
  daemonBootTs: number;
}

export function installObservability(args: InstallObservabilityArgs): ObservabilityCtx {
  // Bootstrap logger with a placeholder dir; real logDir bound at setStateDir.
  // The placeholder is "/dev/null"-style (writes will fail until setStateDir overrides).
  const logger = new JsonLogger({ logDir: "/tmp", clock: args.clock });
  const statusReporter = new StatusReporter(args.clock, args.deploymentMode, args.daemonBootTs);
  const alertDispatcher = new AlertDispatcher({ eventBus: args.eventBus, clock: args.clock, logger });
  const subscriber = new Subscriber({
    eventBus: args.eventBus,
    logger,
    alertDispatcher,
    statusReporter,
    clock: args.clock,
  });
  const measurement = new MeasurementHelper({
    eventBus: args.eventBus,
    clock: args.clock,
    daemonPid: args.daemonPid,
  });
  measurement.start();
  return {
    setStateDir(sd: StateDir) {
      // Replace logger's log dir; reuse same logger instance via direct config mutation.
      (logger as unknown as { cfg: { logDir: string } }).cfg.logDir = sd.logDir;
      logger.start();
      subscriber.setStateDir(sd);
    },
    setTgClient(tg, adminChatId = 0) {
      alertDispatcher.setTgClient(tg, adminChatId);
    },
    getStatusReporter() {
      return statusReporter;
    },
    getLoggerForTest() {
      return logger;
    },
    getAlertDispatcherForTest() {
      return alertDispatcher;
    },
    drainAlertsToLogOnly() {
      return alertDispatcher.drainAlertsToLogOnly();
    },
    dispose() {
      subscriber.stop();
      logger.stop();
      measurement.stop();
    },
  };
}

export { JsonLogger } from "./json-logger";
export { AlertDispatcher } from "./alert-dispatcher";
export { StatusReporter, type StatusSnapshot } from "./status-reporter";
export { Subscriber } from "./subscriber";
export { MeasurementHelper, type MeasurementSample } from "./measurement-helper";
export * from "./redaction";
