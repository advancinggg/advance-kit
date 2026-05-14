import { shortHash } from "../common/hash";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";
import { deleteAdminFile, readAdminFile } from "./admin-file";
import type { AdminAllowlistImpl } from "./allowlist";

export interface AdminStateReset {
  resetAdmin(): { cleared: boolean; prior_admin_hash: string | null };
}

export class AdminStateResetImpl implements AdminStateReset {
  constructor(private stateDir: StateDir, private allowlist: AdminAllowlistImpl, private eventBus: EventBus) {}

  resetAdmin(): { cleared: boolean; prior_admin_hash: string | null } {
    const existing = readAdminFile(this.stateDir, this.eventBus);
    const cleared = deleteAdminFile(this.stateDir);
    if (existing) {
      this.allowlist.clear();
      const hash = shortHash(String(existing.tg_user_id));
      this.eventBus.emit("registration_event", {
        kind: "admin_reset",
        detail: { prior_admin_hash: hash },
      });
      return { cleared: true, prior_admin_hash: hash };
    }
    if (cleared) {
      // We had a file but couldn't read it; still clear allowlist for safety.
      this.allowlist.clear();
    }
    return { cleared: false, prior_admin_hash: null };
  }
}
