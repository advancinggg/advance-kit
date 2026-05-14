import type { Clock } from "../daemon/clock";
import type { DeploymentMode } from "../daemon/deployment-mode";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";
import { AdminAllowlistImpl, parseAuthorizedUsersEnv } from "./allowlist";
import { readAdminFile } from "./admin-file";
import { RegistrationGateImpl } from "./registration-gate";

export interface AdminBootContext {
  allowlist: AdminAllowlistImpl;
  registrationGate: RegistrationGateImpl;
}

export interface BootResolverArgs {
  stateDir: StateDir;
  env: NodeJS.ProcessEnv;
  eventBus: EventBus;
  deploymentMode: DeploymentMode;
  clock: Clock;
}

/** Top-level boot path called by main.ts to populate admin allowlist or open registration window. */
export async function resolveAdminBoot(args: BootResolverArgs): Promise<AdminBootContext> {
  const allowlist = new AdminAllowlistImpl();
  const gate = new RegistrationGateImpl({
    stateDir: args.stateDir,
    allowlist,
    clock: args.clock,
    eventBus: args.eventBus,
    deploymentMode: args.deploymentMode,
  });
  const envValue = args.env.TELEGRAM_AUTHORIZED_USERS;
  if (envValue && envValue.trim().length > 0) {
    let uids: number[];
    try {
      uids = parseAuthorizedUsersEnv(envValue);
    } catch (err) {
      // Malformed env — daemon refuses to start.
      throw err;
    }
    if (uids.length === 0) {
      // env present but empty array — fall through to file/registration
    } else {
      allowlist.setFromEnv(uids);
      args.eventBus.emit("registration_event", { kind: "skipped_env" });
      return { allowlist, registrationGate: gate };
    }
  }
  // env not set or empty → try admin.json.
  const fileContent = readAdminFile(args.stateDir, args.eventBus);
  if (fileContent) {
    allowlist.setFromFile(fileContent.tg_user_id);
    args.eventBus.emit("registration_event", { kind: "skipped_file" });
    return { allowlist, registrationGate: gate };
  }
  // Open registration window.
  gate.openWindow();
  return { allowlist, registrationGate: gate };
}
