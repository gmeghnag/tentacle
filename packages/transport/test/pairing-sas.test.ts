/**
 * The pairing compare code (docs/feat/device-pairing.md 9a, Design "Compare
 * code (SAS)").
 *
 * The property: the code BINDS BOTH KEYS. A SAS over only one key (the
 * mutation this suite names) would let an attacker pair with the real phone's
 * key in the mix — so the fixed vector below is computed independently
 * (`node:crypto`, SHA-256 of the same bytes) and swapping either key must
 * move the code. Six digits, zero-padded, always.
 */
import { describe, expect, test } from "bun:test";
import { PAIRING_SAS_DIGITS, formatPairingSas, pairingSas } from "../src/pairing-sas.ts";

const a = new Uint8Array(32).fill(1);
const b = new Uint8Array(32).fill(2);
const c = new Uint8Array(32).fill(3);

describe("pairingSas", () => {
  // Vectors computed with node:crypto over
  // SHA-256("tentacle-pair-sas/1" || computerPub || devicePub)[0..4] as a
  // big-endian uint32, mod 10^6 — an implementation this test does not share.
  test("matches an independently computed vector", () => {
    expect(pairingSas(a, b)).toBe("236830");
    expect(pairingSas(a, c)).toBe("995711");
  });

  test("swapping the two keys changes the code", () => {
    expect(pairingSas(b, a)).toBe("626053");
    expect(pairingSas(b, a)).not.toBe(pairingSas(a, b));
  });

  test("always six digits, zero-padded", () => {
    for (const fill of [0, 1, 2, 7, 200, 255]) {
      const sas = pairingSas(new Uint8Array(32).fill(fill), new Uint8Array(32).fill(fill + 1));
      expect(sas).toHaveLength(PAIRING_SAS_DIGITS);
      expect(sas).toMatch(/^\d{6}$/);
    }
  });

  test("a wrong key length is a caller bug, not a silent hash", () => {
    expect(() => pairingSas(new Uint8Array(16), b)).toThrow("32 bytes");
    expect(() => pairingSas(a, new Uint8Array(0))).toThrow("32 bytes");
  });

  test("is deterministic", () => {
    expect(pairingSas(a, b)).toBe(pairingSas(new Uint8Array(a), new Uint8Array(b)));
  });

  test("formatting groups the digits", () => {
    expect(formatPairingSas("236830")).toBe("236 830");
  });
});
