import type { Clock } from "../daemon/clock";
import type { DeploymentMode } from "../daemon/deployment-mode";

export interface StatusSnapshot {
  uptime_seconds: number;
  deployment_mode: DeploymentMode;
  polling_state: "running" | "quarantine" | "paused";
  quarantine_active: boolean;
  last_inbound_ts: number | null;
  registered_sessions: number;
  pending_approvals: { current: number; max: number };
  admin_source: "env" | "file" | "none";
}

export class StatusReporter {
  private bootTs: number;
  private deploymentMode: DeploymentMode;
  private pollingState: "running" | "quarantine" | "paused" = "running";
  private lastInboundTs: number | null = null;
  private registeredSessions = 0;
  private pendingCurrent = 0;
  private pendingMax = 50;
  private adminSource: "env" | "file" | "none" = "none";

  constructor(private clock: Clock, deploymentMode: DeploymentMode, bootTs: number) {
    this.bootTs = bootTs;
    this.deploymentMode = deploymentMode;
  }

  setBootTs(ts: number): void {
    this.bootTs = ts;
  }
  setPollingState(state: "running" | "quarantine" | "paused"): void {
    this.pollingState = state;
  }
  setLastInboundTs(ts: number): void {
    this.lastInboundTs = ts;
  }
  sessionConnected(): void {
    this.registeredSessions += 1;
  }
  sessionDisconnected(): void {
    this.registeredSessions = Math.max(0, this.registeredSessions - 1);
  }
  setPendingCapacity(current: number, max: number): void {
    this.pendingCurrent = current;
    this.pendingMax = max;
  }
  setAdminSource(source: "env" | "file" | "none"): void {
    this.adminSource = source;
  }

  getSnapshot(): StatusSnapshot {
    return {
      uptime_seconds: Math.floor((this.clock.now() - this.bootTs) / 1000),
      deployment_mode: this.deploymentMode,
      polling_state: this.pollingState,
      quarantine_active: this.pollingState === "quarantine",
      last_inbound_ts: this.lastInboundTs,
      registered_sessions: this.registeredSessions,
      pending_approvals: { current: this.pendingCurrent, max: this.pendingMax },
      admin_source: this.adminSource,
    };
  }
}
