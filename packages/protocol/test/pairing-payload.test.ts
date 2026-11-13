/**
 * The pairing payload codec (docs/feat/device-pairing.md 9a, Design "Pairing
 * payload").
 *
 * The property: what `pair` prints is exactly what an app reads back —
 * including a name with spaces and non-ASCII — while a payload that is
 * required-and-wrong is refused with a reason, never half-read. Unknown params
 * are IGNORED (a later task may add one; AGENTS §7 forward compatibility
 * applied to a QR), and the key encoding is canonical, so one key has exactly
 * one string form.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PAIRING_ADDRESSES,
  PAIRING_CODE_LENGTH,
  PAIRING_PAYLOAD_VERSION,
  decodeBase64Url,
  encodeBase64Url,
  formatPairingPayload,
  isPairingAddress,
  normalizePairingCode,
  parsePairingPayload,
} from "../src/index.ts";

const KEY = new Uint8Array(32).fill(7);
const ADDRESS = "ws://192.168.1.8:4001/e2e";
const payload = (over: Partial<Parameters<typeof formatPairingPayload>[0]> = {}) => ({
  v: PAIRING_PAYLOAD_VERSION,
  key: KEY,
  computer: "gabriel-mac",
  code: "K7M2QX9AB3",
  addresses: [ADDRESS],
  ...over,
});

const parse = (text: string) => parsePairingPayload(text);

describe("base64url", () => {
  test("round-trips every length remainder and stays unpadded", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) & 0xff);
      const text = encodeBase64Url(bytes);
      expect(text).not.toContain("=");
      expect([...(decodeBase64Url(text) ?? [])]).toEqual([...bytes]);
    }
    expect(encodeBase64Url(KEY).length).toBe(43);
  });

  test("refuses a non-canonical encoding (two strings, one key)", () => {
    // A 32-byte key is 43 base64url characters: the last one carries 4 payload
    // bits and 2 PAD bits, so flipping a pad bit yields a string that decodes
    // to the SAME key. Exactly one string form per key, or a stored key could
    // be compared against a different textual form of itself.
    const text = encodeBase64Url(KEY);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(text.charAt(text.length - 1));
    expect(last).toBeGreaterThanOrEqual(0);
    const forged = `${text.slice(0, -1)}${alphabet.charAt(last | 1)}`;
    expect(forged).not.toBe(text);
    expect(decodeBase64Url(forged)).toBeUndefined();
    // Without the canonicality check the forged string decodes — to the same
    // key, which is why the check is the property and not a nicety.
    expect(decodeBase64Url(`${text}==`)).toBeUndefined();
    expect(decodeBase64Url("a+b/")).toBeUndefined();
    expect(decodeBase64Url("A")).toBeUndefined();
  });
});

describe("payload round trip", () => {
  test("keeps the key, the name, the code and the addresses", () => {
    const text = formatPairingPayload(payload());
    expect(text.startsWith("tentacle://pair?v=1&")).toBe(true);
    const result = parse(text);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.payload.v).toBe(PAIRING_PAYLOAD_VERSION);
    expect([...result.payload.key]).toEqual([...KEY]);
    expect(result.payload.computer).toBe("gabriel-mac");
    expect(result.payload.code).toBe("K7M2QX9AB3");
    expect(result.payload.addresses).toEqual([ADDRESS]);
  });

  test("survives a name with spaces, an accent and an ampersand", () => {
    const name = "iPhone di Gabriele & Co";
    const text = formatPairingPayload(payload({ computer: name }));
    const result = parse(text);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.payload.computer).toBe(name);
  });

  test("several addresses keep their order and are deduped", () => {
    const second = "wss://100.64.0.2:4001/e2e";
    const text = formatPairingPayload(payload({ addresses: [ADDRESS, second, ADDRESS] }));
    const result = parse(text);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.payload.addresses).toEqual([ADDRESS, second]);
  });

  test("a lower-case code reads back canonical", () => {
    const text = formatPairingPayload(payload({ code: "k7m2qx9ab3" }));
    const result = parse(text);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.payload.code).toBe("K7M2QX9AB3");
  });
});

describe("lenient where it may be", () => {
  test("an unknown parameter is ignored, not refused", () => {
    const text = `${formatPairingPayload(payload())}&x=1&relay=https%3A%2F%2Fexample`;
    const result = parse(text);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.payload.computer).toBe("gabriel-mac");
  });

  test("surrounding whitespace from a copy-paste is trimmed", () => {
    const result = parse(`  ${formatPairingPayload(payload())}\n`);
    expect(result.ok).toBe(true);
  });
});

describe("refusals carry a reason", () => {
  const base = () => formatPairingPayload(payload());
  const withParam = (name: string, value: string) => {
    const url = new URL(base());
    url.searchParams.set(name, value);
    return url.toString();
  };

  test("a foreign prefix", () => {
    expect(parse("https://pair?v=1")).toEqual({ ok: false, reason: "prefix" });
    expect(parse("")).toEqual({ ok: false, reason: "prefix" });
  });

  test("an unknown or missing version", () => {
    expect(parse(withParam("v", "2"))).toEqual({ ok: false, reason: "version" });
    expect(parse(withParam("v", ""))).toEqual({ ok: false, reason: "version" });
  });

  test("a key that is not 32 bytes, or not base64url", () => {
    expect(parse(withParam("k", encodeBase64Url(new Uint8Array(16))))).toEqual({
      ok: false,
      reason: "key",
    });
    expect(parse(withParam("k", "not a key!"))).toEqual({ ok: false, reason: "key" });
  });

  test("a name that is empty or carries a control character", () => {
    expect(parse(withParam("n", ""))).toEqual({ ok: false, reason: "name" });
    expect(parse(withParam("n", "mac\u001b[2J"))).toEqual({ ok: false, reason: "name" });
  });

  test("a code that is not 10 Crockford characters", () => {
    expect(parse(withParam("c", "SHORT"))).toEqual({ ok: false, reason: "code" });
    expect(parse(withParam("c", "K7M2QX9ABU"))).toEqual({ ok: false, reason: "code" });
  });

  test("an address that is not a ws(s) URL ending in /e2e", () => {
    for (const address of [
      "http://192.168.1.8:4001/e2e",
      "ws://192.168.1.8:4001/",
      "ws:///e2e",
      "nonsense",
    ]) {
      expect(parse(withParam("a", address))).toEqual({ ok: false, reason: "address" });
    }
  });

  test("no address at all", () => {
    const url = new URL(base());
    url.searchParams.delete("a");
    expect(parse(url.toString())).toEqual({ ok: false, reason: "no_address" });
  });

  test("too many addresses", () => {
    const many = Array.from(
      { length: MAX_PAIRING_ADDRESSES + 1 },
      (_, i) => `ws://10.0.0.${i}:4001/e2e`,
    );
    expect(parse(formatPairingPayloadRaw(payload(), many))).toEqual({
      ok: false,
      reason: "address",
    });
  });
});

/** Encode with an address count `formatPairingPayload` would refuse (the parse bound is the one under test). */
function formatPairingPayloadRaw(p: ReturnType<typeof payload>, addresses: string[]): string {
  const parts = [
    `v=${PAIRING_PAYLOAD_VERSION}`,
    `k=${encodeBase64Url(p.key)}`,
    `n=${encodeURIComponent(p.computer)}`,
    `c=${p.code}`,
    ...addresses.map((a) => `a=${encodeURIComponent(a)}`),
  ];
  return `tentacle://pair?${parts.join("&")}`;
}

describe("helpers", () => {
  test("a code normalizes to upper case, or is undefined", () => {
    expect(normalizePairingCode("k7m2qx9ab3")).toBe("K7M2QX9AB3");
    expect(normalizePairingCode("K7M2QX9ABU")).toBeUndefined();
    expect(PAIRING_CODE_LENGTH).toBe(10);
  });

  test("an address is a ws(s) URL ending in /e2e", () => {
    expect(isPairingAddress(ADDRESS)).toBe(true);
    expect(isPairingAddress("wss://relay.example/e2e")).toBe(true);
    expect(isPairingAddress("https://relay.example/e2e")).toBe(false);
    expect(isPairingAddress("ws://relay.example/e2e?x=1")).toBe(true);
  });
});
