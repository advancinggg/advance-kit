import { shortHash } from "../common/hash";

const BOT_TOKEN_REGEX = /bot[0-9]+:[A-Za-z0-9_-]+/g;
const REGISTRATION_CODE_REGEX = /\b[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}\b/g;

const USER_ID_KEYS = new Set([
  "tg_user_id",
  "user_id",
  "from_id",
  "admin_user_id",
  "sender_id",
  "callback_from_id",
]);

const TEXT_KEYS = new Set(["text", "message_text", "dm_text", "tool_params"]);

const PROJECT_PATH_KEYS = new Set(["project_path", "cwd"]);

const CODE_KEYS = new Set(["registration_code", "code"]);

export interface RedactionContext {
  /** Optional cap on string-walking depth to avoid pathological structures. */
  maxDepth?: number;
}

export function redactString(s: string): string {
  return s.replace(BOT_TOKEN_REGEX, "bot[REDACTED]").replace(REGISTRATION_CODE_REGEX, "code[REDACTED]");
}

export function redactProjectPath(p: string): string {
  const parts = p.split("/").filter((x) => x.length > 0);
  if (parts.length <= 2) return p;
  const first = parts[0];
  const leaf = parts[parts.length - 1];
  return `/${first}/.../${leaf}`;
}

export function redactPayload(input: unknown, ctx: RedactionContext = {}): unknown {
  return walk(input, 0, ctx.maxDepth ?? 16);
}

function walk(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return "[max-depth-reached]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, maxDepth));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (USER_ID_KEYS.has(k) && (typeof v === "number" || typeof v === "string")) {
        out[k] = shortHash(String(v));
      } else if (k === "from" && typeof v === "object" && v !== null) {
        // Telegram update.from object — hash any id we find inside.
        const inner = v as Record<string, unknown>;
        const cloned: Record<string, unknown> = {};
        for (const [ik, iv] of Object.entries(inner)) {
          if ((ik === "id" || ik === "user_id") && (typeof iv === "number" || typeof iv === "string")) {
            cloned[ik] = shortHash(String(iv));
          } else {
            cloned[ik] = walk(iv, depth + 2, maxDepth);
          }
        }
        out[k] = cloned;
      } else if (TEXT_KEYS.has(k) && typeof v === "string") {
        out[k] = { hash: shortHash(v), length: v.length };
      } else if (PROJECT_PATH_KEYS.has(k) && typeof v === "string") {
        out[k] = redactProjectPath(v);
      } else if (CODE_KEYS.has(k) && typeof v === "string") {
        out[k] = "code[REDACTED]";
      } else if (k === "token" && typeof v === "string") {
        out[k] = "bot[REDACTED]";
      } else {
        out[k] = walk(v, depth + 1, maxDepth);
      }
    }
    return out;
  }
  return value;
}
