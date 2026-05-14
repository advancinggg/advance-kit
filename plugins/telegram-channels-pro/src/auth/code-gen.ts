import { randomBytes } from "node:crypto";

/** 32-char alphabet excluding 0/O/I/1 per PRD §4.7. */
export const REGISTRATION_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const REGISTRATION_CODE_LENGTH = 6;

/**
 * Generate a 6-char registration code using uniform rejection sampling so that each
 * code position is equiprobable across the 32-char alphabet. We sample bytes, mask to
 * 5 bits, and accept results < 32. Worst-case overhead is small (32 / 32 acceptance).
 */
export function generateRegistrationCode(): string {
  const alphabet = REGISTRATION_CODE_ALPHABET;
  if (alphabet.length !== 32) throw new Error("REGISTRATION_CODE_ALPHABET length must be 32");
  const out: string[] = [];
  let buf = randomBytes(64); // ample buffer
  let cursor = 0;
  while (out.length < REGISTRATION_CODE_LENGTH) {
    if (cursor >= buf.byteLength) {
      buf = randomBytes(64);
      cursor = 0;
    }
    const byte = buf[cursor++]!;
    const idx = byte & 0x1f; // 0..31
    out.push(alphabet[idx]!);
  }
  return out.join("");
}

/** Validate a candidate code string against the alphabet + exact length. Case-sensitive. */
export const REGISTRATION_CODE_REGEX = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

export function isValidCode(candidate: string): boolean {
  return REGISTRATION_CODE_REGEX.test(candidate);
}
