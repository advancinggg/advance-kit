import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Return a 12-char SHA-256 hex prefix for redaction of small IDs / codes. */
export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 12);
}
