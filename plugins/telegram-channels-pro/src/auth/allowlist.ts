export type AdminSource = "env" | "file" | "none";

export interface AdminAllowlist {
  isAdmin(tgUserId: number): boolean;
  source(): AdminSource;
  list(): number[];
}

export class AdminAllowlistImpl implements AdminAllowlist {
  private members = new Set<number>();
  private currentSource: AdminSource = "none";

  setFromEnv(uids: number[]): void {
    this.members = new Set(uids);
    this.currentSource = "env";
  }

  setFromFile(uid: number): void {
    this.members = new Set([uid]);
    this.currentSource = "file";
  }

  clear(): void {
    this.members.clear();
    this.currentSource = "none";
  }

  isAdmin(tgUserId: number): boolean {
    return this.members.has(tgUserId);
  }

  source(): AdminSource {
    return this.currentSource;
  }

  list(): number[] {
    return Array.from(this.members);
  }
}

/**
 * Parse TELEGRAM_AUTHORIZED_USERS env value. Accepts either a JSON array of integers
 * `"[123, 456]"`, or a single integer `"123"`. Throws on malformed input.
 */
export function parseAuthorizedUsersEnv(raw: string): number[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  // single integer fast path
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`TELEGRAM_AUTHORIZED_USERS malformed: "${raw}"`);
    return [n];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`TELEGRAM_AUTHORIZED_USERS not valid JSON: ${String((err as Error)?.message ?? err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("TELEGRAM_AUTHORIZED_USERS must be a JSON array or single integer");
  const out: number[] = [];
  for (const v of parsed) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
      throw new Error(`TELEGRAM_AUTHORIZED_USERS contains invalid entry: ${JSON.stringify(v)}`);
    }
    out.push(v);
  }
  return out;
}
