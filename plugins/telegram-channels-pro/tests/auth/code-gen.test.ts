import { describe, expect, test } from "bun:test";
import {
  generateRegistrationCode,
  REGISTRATION_CODE_ALPHABET,
  REGISTRATION_CODE_LENGTH,
  REGISTRATION_CODE_REGEX,
  isValidCode,
} from "../../src/auth/code-gen";

describe("MODULE-006-AC-04: registration code generation", () => {
  test("MODULE-006-T04 — generated code is 6 chars from 32-char alphabet excluding 0/O/I/1", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRegistrationCode();
      expect(code.length).toBe(REGISTRATION_CODE_LENGTH);
      expect(REGISTRATION_CODE_REGEX.test(code)).toBe(true);
      for (const ch of code) {
        expect(REGISTRATION_CODE_ALPHABET).toContain(ch);
        expect("0OI1").not.toContain(ch);
      }
    }
  });

  test("MODULE-006-T16 — code matching is case-sensitive", () => {
    expect(isValidCode("ABCDEF")).toBe(true);
    expect(isValidCode("abcdef")).toBe(false);
    expect(isValidCode("ABCDE0")).toBe(false); // contains '0'
    expect(isValidCode("ABCDE1")).toBe(false); // contains '1'
    expect(isValidCode("ABCDEI")).toBe(false); // contains 'I'
    expect(isValidCode("ABCDEO")).toBe(false); // contains 'O'
    expect(isValidCode("ABCDE")).toBe(false); // 5 chars
    expect(isValidCode("ABCDEFG")).toBe(false); // 7 chars
  });
});
