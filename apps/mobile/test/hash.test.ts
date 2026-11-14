/**
 * `hash` (docs/feat/mobile-compose.md D5, 13c): the phone's sha-256 must be the
 * SAME digest Bun computes, byte for byte — the id it produces is what the
 * daemon re-verifies after the upload, so "roughly right" is a refused blob.
 *
 * Bun's `CryptoHasher` is the oracle (it is the client package's own default on
 * the laptop, `remote-client.ts:477-492`); the app's hasher is noble, which is
 * what makes it run under Hermes at all.
 */
import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/hash.ts";

/** Bun's own digest of the same bytes — the oracle, not a copy of noble. */
function bunHex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

function bytesOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  return bytes;
}

describe("sha256Hex — noble's hex IS Bun's hex", () => {
  // The empty input is the classic self-test: its digest is published and a
  // hasher that mishandles a zero-length update returns the padding block only.
  test("the empty input is the published digest", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("lengths 0/1/64/1 MiB+1 (block boundaries and past a megabyte) match Bun", () => {
    for (const length of [0, 1, 64, 1024 * 1024 + 1]) {
      expect(sha256Hex(bytesOf(length))).toBe(bunHex(bytesOf(length)));
    }
  });

  test("every byte above 0x7f is hashed as a BYTE, never re-encoded as UTF-8", () => {
    // The reason `sha256Bytes` exists beside the text `sha256` seam: a text
    // hasher would turn 0x80 into two bytes and change the digest.
    const high = new Uint8Array([0x80, 0xff, 0xfe, 0xc3, 0x28]);
    expect(sha256Hex(high)).toBe(bunHex(high));
    expect(sha256Hex(high)).not.toBe(
      bunHex(new TextEncoder().encode(String.fromCharCode(...high))),
    );
  });

  test("the output is lowercase hex and always 64 chars (the wire's ATTACHMENT_ID_RE)", () => {
    const digest = sha256Hex(bytesOf(300));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different bytes never collide silently", () => {
    expect(sha256Hex(bytesOf(16))).not.toBe(sha256Hex(bytesOf(17)));
  });
});
