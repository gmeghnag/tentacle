/**
 * `envelopeFaultsOf` (docs/feat/mobile-push.md P10): the decision the
 * `push-placeholder` flow's last step reports.
 *
 * Each test names the mutation it kills. The important one is M6 below — the
 * SAME mutation was first aimed at the flow's inline script and SURVIVED, because
 * that guard asserted the presence of a string (`"704"`) rather than the
 * behaviour. A test that cannot fail is worse than none (AGENTS §9), so the
 * decision moved here and is now checked by the property, not by its source text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_ENVELOPE_CIPHERTEXT_LENGTHS } from "@tentacle/protocol";
import { envelopeFaultsOf } from "../e2e/push-envelope.ts";

/** A payload of exactly the shape `sealPush` + the relay's template produce. */
function sealed(ciphertextLength = PUSH_ENVELOPE_CIPHERTEXT_LENGTHS[0] as number): unknown {
  return {
    aps: {
      alert: { title: "tentacle", body: "Open tentacle to see what's new" },
      "mutable-content": 1,
    },
    tp: {
      v: 1,
      k: "a".repeat(12),
      e: "b".repeat(43),
      c: "c".repeat(ciphertextLength),
    },
  };
}

describe("a real sealed envelope has no faults", () => {
  test("the 512-byte bucket", () => {
    expect(envelopeFaultsOf(sealed(PUSH_ENVELOPE_CIPHERTEXT_LENGTHS[0]), "t")).toEqual([]);
  });

  test("every bucket is accepted, and only the buckets are", () => {
    for (const length of PUSH_ENVELOPE_CIPHERTEXT_LENGTHS) {
      expect(envelopeFaultsOf(sealed(length), "t")).toEqual([]);
    }
    // M6: the padding claim. A ciphertext of ANY other length is a plaintext that
    // was not padded, so the envelope's size would leak the kind (Design 2).
    for (const wrong of [1, 4, 512, 703, 705, 1386, 1388, 2751, 2753, 4096]) {
      const faults = envelopeFaultsOf(sealed(wrong), "t");
      expect({ wrong, faults: faults.length > 0 }).toEqual({ wrong, faults: true });
      expect(faults.join(" ")).toContain("not padded");
    }
  });
});

describe("every way a payload can be wrong names its own field", () => {
  test("no `aps` at all → a fault (iOS would draw nothing)", () => {
    // A spread that omits the key, not a `delete` (Biome's `noDelete`).
    const withAps = sealed() as unknown as Record<string, unknown>;
    const { aps: _dropped, ...rest } = withAps;
    expect(envelopeFaultsOf(rest, "t").join(" ")).toContain("no `aps`");
  });

  test("no `tp` → a fault, and it says the envelope is missing", () => {
    expect(envelopeFaultsOf({ aps: {} }, "t").join(" ")).toContain("no sealed envelope");
  });

  test("a wrong version is a fault (a future NSE's record this build cannot read)", () => {
    const payload = sealed() as { tp: { v: number } };
    payload.tp.v = 2;
    expect(envelopeFaultsOf(payload, "t").join(" ")).toContain("version is not 1");
  });

  test("a key id of the wrong length is a fault", () => {
    // M-k: an empty or truncated `k` would let the extension pick the wrong
    // computer's key (or none), which is a silent non-delivery on the phone.
    const payload = sealed() as { tp: { k: string } };
    payload.tp.k = "short";
    expect(envelopeFaultsOf(payload, "t").join(" ")).toContain("key id is not 12");
  });

  test("an enc of the wrong length is a fault", () => {
    const payload = sealed() as { tp: { e: string } };
    payload.tp.e = "tiny";
    expect(envelopeFaultsOf(payload, "t").join(" ")).toContain("enc is not 43");
  });

  test("a non-string ciphertext is a fault, not a crash", () => {
    // A flow must FAIL with a sentence, never with a TypeError Maestro reports as
    // an unexplained script error.
    const payload = sealed() as { tp: { c: unknown } };
    payload.tp.c = 42;
    expect(envelopeFaultsOf(payload, "t").join(" ")).toContain("not a string");
  });

  test("a payload that is not an object at all is one sentence", () => {
    expect(envelopeFaultsOf("nope", "t")).toEqual(['the APNs payload is not an object: "nope"']);
  });
});

describe("the flow's script and this module cannot drift", () => {
  // A Maestro `runScript` has no imports, so the flow's check is a COPY of the
  // rules above. That copy is the one that actually runs in the gate's absence
  // (it needs a simulator), which is exactly why its numbers are pinned here:
  // the module is tested, and the script is held to it.
  const script = readFileSync(
    join(import.meta.dir, "..", "e2e", "flows", "push-assert.js"),
    "utf8",
  );

  test("it pins the same three bucket lengths the protocol declares", () => {
    for (const length of PUSH_ENVELOPE_CIPHERTEXT_LENGTHS) {
      expect(script).toContain(String(length));
    }
  });

  test("it is a whitelist (`includes`), never a `false` that switches the check off", () => {
    // The M6 mutation: `if (false) {` in this file made the whole padding rule
    // vanish while every other assertion still passed. A structural assertion on
    // the shape of the check is what makes that visible without a simulator.
    expect(script).toContain("!buckets.includes(ciphertext.length)");
    expect(script).not.toMatch(/if\s*\(\s*false\s*\)/);
  });

  test("it checks the key id and the enc at the protocol's own lengths", () => {
    expect(script).toContain("!== 12");
    expect(script).toContain("!== 43");
  });
});
