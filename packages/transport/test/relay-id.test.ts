/**
 * `relayIdOf` — the relay's self-certifying daemon id (docs/feat/mobile-relay.md,
 * Owner Q4 / failure mode F8).
 *
 * The property: the id is PUBLIC and the secret is NOT, and the id can only be
 * computed from the secret. The fixed vector is computed independently
 * (`node:crypto`: SHA-256 of the same bytes, base64url, first 22 chars), so a
 * domain-separator change, a length change or a different truncation breaks it
 * — that is the mutation this suite names.
 */
import { describe, expect, test } from "bun:test";
import { RELAY_ID_LENGTH, isRelayId } from "@tentacle/protocol";
import { RELAY_ID_PREFIX, relayIdOf } from "../src/relay-id.ts";

const secret = new Uint8Array(32);
for (let i = 0; i < 32; i++) secret[i] = i;

describe("relayIdOf", () => {
  // Vector computed with node:crypto over
  // b64url(SHA-256("tentacle-relay-id/1" ‖ secret))[0..22] — an implementation
  // this test does not share.
  test("matches an independently computed vector", () => {
    expect(RELAY_ID_PREFIX).toBe("tentacle-relay-id/1");
    expect(relayIdOf(secret)).toBe("WSbKVXnUw63XiNj5KDcKsU");
  });

  test("is a well-formed id of exactly RELAY_ID_LENGTH characters", () => {
    const id = relayIdOf(secret);
    expect(id.length).toBe(RELAY_ID_LENGTH);
    expect(isRelayId(id)).toBe(true);
  });

  test("every secret bit moves the id", () => {
    const seen = new Set<string>();
    for (let bit = 0; bit < 32 * 8; bit++) {
      const mutated = secret.slice();
      mutated[bit >> 3] = (mutated[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      seen.add(relayIdOf(mutated));
    }
    // 256 one-bit neighbours, all distinct and none equal to the base id: the
    // hash is the only thing standing between a squatter and this id (F8).
    expect(seen.size).toBe(256);
    expect(seen.has(relayIdOf(secret))).toBe(false);
  });

  test("refuses a wrong-size secret instead of aliasing two secrets onto one id", () => {
    for (const size of [0, 1, 31, 33, 64]) {
      expect(() => relayIdOf(new Uint8Array(size))).toThrow();
    }
  });
});
