import type { DeploymentMode } from "./event-types";
export type { DeploymentMode };

let cached: DeploymentMode | undefined;

export function detectDeploymentMode(env: NodeJS.ProcessEnv, ppid: number): DeploymentMode {
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME.length > 0) return "launchd";
  if (env.LAUNCHD_SOCKET && env.LAUNCHD_SOCKET.length > 0) return "launchd";
  if (ppid === 1) return "launchd";
  return "lazy-spawn";
}

export function getDeploymentMode(env?: NodeJS.ProcessEnv, ppid?: number): DeploymentMode {
  if (cached !== undefined) return cached;
  cached = detectDeploymentMode(env ?? process.env, ppid ?? process.ppid);
  return cached;
}

export function resetDeploymentModeCacheForTest(): void {
  cached = undefined;
}
