import * as fs from "node:fs";
import * as net from "node:net";
import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";
import type { DeploymentMode } from "../daemon/deployment-mode";
import type { StatusSnapshot } from "../obs/status-reporter";

export interface ControlSocketConfig {
  stateDir: StateDir;
  eventBus: EventBus;
  clock: Clock;
  deploymentMode: DeploymentMode;
  /** Returns the current StatusReporter snapshot. */
  getSnapshot: () => StatusSnapshot;
  /**
   * Performs admin reset (M006 AdminStateReset.resetAdmin + RegistrationGate.forceReopenForReset).
   * Returns the result merged with deployment_mode + daemon_pid.
   */
  resetAdmin: () => {
    cleared: boolean;
    prior_admin_hash: string | null;
    deployment_mode: DeploymentMode;
    daemon_pid: number;
  };
}

interface ControlRequest {
  kind: "status_request" | "reset_admin_request";
}

/**
 * M007 daemon-side ControlSocket — bind UDS at `<state_dir>/daemon.ctl.sock`,
 * chmod 0600. Distinct from the MCP socket (M003) so M003 stays transport-pure.
 *
 * Frame protocol: newline-delimited JSON. One-shot exchange (single request line +
 * single response line + close).
 */
export class ControlSocket {
  private cfg: ControlSocketConfig;
  private server: net.Server | null = null;

  constructor(cfg: ControlSocketConfig) {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const socketPath = this.cfg.stateDir.controlSocketFile;
    const server = net.createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (err) {
      process.stderr.write(`control-socket: chmod 0600 failed for ${socketPath}: ${String(err)}\n`);
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleConnection(sock: net.Socket): void {
    let buf = "";
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        sock.end();
      } catch {
        /* ignore */
      }
    };
    sock.setEncoding("utf-8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nlIdx = buf.indexOf("\n");
      if (nlIdx < 0) return; // wait for full line
      const line = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 1);
      this.dispatchRequest(line)
        .then((response) => {
          try {
            sock.write(JSON.stringify(response) + "\n");
          } catch {
            /* ignore */
          }
          close();
        })
        .catch((err) => {
          try {
            sock.write(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }) + "\n");
          } catch {
            /* ignore */
          }
          close();
        });
    });
    sock.on("error", () => close());
    sock.on("close", () => close());
  }

  private async dispatchRequest(line: string): Promise<unknown> {
    let req: ControlRequest;
    try {
      req = JSON.parse(line) as ControlRequest;
    } catch {
      return { ok: false, error: "malformed_json" };
    }
    if (req.kind === "status_request") {
      const snap = this.cfg.getSnapshot();
      return { ok: true, result: snap };
    }
    if (req.kind === "reset_admin_request") {
      const result = this.cfg.resetAdmin();
      return { ok: true, result };
    }
    return { ok: false, error: "unknown_kind" };
  }
}
