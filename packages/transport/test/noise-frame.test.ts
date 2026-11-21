/**
 * The secure channel's pure framing (docs/feat/e2e-channel.md, Framing): the
 * canonical base64 codec (still used by attachments and artifact reads), the
 * v2 binary frame checks and version byte, chunking of UTF-8 bytes into
 * Noise-sized plaintexts, and reassembly with its cap.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_CHUNK,
  Reassembler,
  TYPE_CONFIRM,
  TYPE_CONTINUATION,
  TYPE_FINAL,
  binaryFrame,
  chunk,
  decodeBase64,
  encodeBase64,
  readVersioned,
  withVersion,
} from "../src/noise-frame.ts";
import { MAX_NOISE_MESSAGE, NoiseError, TAGLEN } from "../src/noise.ts";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

function badFrame(fn: () => unknown): NoiseError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(NoiseError);
    expect((error as NoiseError).kind).toBe("bad-frame");
    return error as NoiseError;
  }
  throw new Error("expected a bad-frame NoiseError");
}

describe("base64", () => {
  test("RFC 4648 §10 vectors, both ways", () => {
    const rfc: [string, string][] = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, coded] of rfc) {
      expect(encodeBase64(ascii(plain))).toBe(coded);
      expect(new TextDecoder().decode(decodeBase64(coded))).toBe(plain);
    }
  });

  test("agrees with Buffer on every byte value and every length mod 3", () => {
    for (let n = 0; n < 300; n++) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 151 + n) & 0xff;
      const coded = encodeBase64(b);
      expect(coded).toBe(Buffer.from(b).toString("base64"));
      expect(Array.from(decodeBase64(coded))).toEqual(Array.from(b));
    }
  });

  test("non-canonical input is refused", () => {
    for (const bad of [
      "Zh==", // unused bits set
      "Zm9=", // unused bits set
      "Zg", // missing padding
      "Zg=",
      "Zm9v====",
      "Zg==Zg==", // padding inside
      "Zm9v\n",
      " Zm9v",
      "Zm-v", // url-safe alphabet
      "Zm_v",
      "Z===",
      "====",
    ]) {
      badFrame(() => decodeBase64(bad));
    }
  });
});

describe("binary frames (E2E v2)", () => {
  test("a binary frame is the Noise message itself", () => {
    const m = Uint8Array.of(0, 1, 2, 250, 255);
    expect(binaryFrame(m)).toBe(m);
  });

  test("a text frame, an empty frame: bad-frame before any decrypt", () => {
    expect(badFrame(() => binaryFrame('{"jsonrpc":"2.0"}')).message).toContain("text frame");
    expect(badFrame(() => binaryFrame("t1:AAAA")).message).toContain("text frame");
    expect(badFrame(() => binaryFrame(new Uint8Array(0))).message).toContain("empty");
  });

  test("the largest Noise message fits; one byte more is refused", () => {
    expect(binaryFrame(new Uint8Array(MAX_NOISE_MESSAGE)).length).toBe(MAX_NOISE_MESSAGE);
    expect(badFrame(() => binaryFrame(new Uint8Array(MAX_NOISE_MESSAGE + 1))).message).toContain(
      "too long",
    );
  });

  test("a versioned flight round-trips; the version byte allows one byte over the Noise maximum", () => {
    const m = new Uint8Array(MAX_NOISE_MESSAGE).fill(9);
    const flight = withVersion(2, m);
    expect(flight[0]).toBe(2);
    expect(flight.length).toBe(MAX_NOISE_MESSAGE + 1);
    expect(readVersioned(flight, 2).length).toBe(MAX_NOISE_MESSAGE);
    badFrame(() => readVersioned(new Uint8Array(MAX_NOISE_MESSAGE + 2).fill(2), 2));
  });

  test("version skew is named before any crypto, with the remote version", () => {
    const mismatch = (fn: () => unknown): NoiseError => {
      try {
        fn();
      } catch (error) {
        expect((error as NoiseError).kind).toBe("version-mismatch");
        return error as NoiseError;
      }
      throw new Error("expected version-mismatch");
    };
    expect(mismatch(() => readVersioned("t1:AAAA", 2)).remoteVersion).toBe(1);
    expect(mismatch(() => readVersioned(Uint8Array.of(3), 2)).remoteVersion).toBe(3);
    expect(mismatch(() => readVersioned(Uint8Array.of(1, 9, 9), 2)).remoteVersion).toBe(1);
    // A lone byte of our own version is not a refusal; other text is garbage, not a version.
    badFrame(() => readVersioned(Uint8Array.of(2), 2));
    badFrame(() => readVersioned('{"jsonrpc":"2.0"}', 2));
    badFrame(() => readVersioned(new Uint8Array(0), 2));
  });
});

describe("chunking and reassembly", () => {
  const roundTrip = (data: string, max = 1 << 30): string | null => {
    const r = new Reassembler(max);
    let out: string | null = null;
    for (const p of chunk(data)) {
      expect(out).toBeNull(); // nothing is delivered before the final chunk
      out = r.push(p);
    }
    return out;
  };

  test("chunk boundaries: 0, 1, 65 517, 65 518, 65 519 and 200 000 bytes", () => {
    expect(MAX_CHUNK).toBe(MAX_NOISE_MESSAGE - TAGLEN - 1);
    const cases: [number, number][] = [
      [0, 1],
      [1, 1],
      [65_517, 1],
      [65_518, 1],
      [65_519, 2],
      [200_000, 4],
    ];
    for (const [size, count] of cases) {
      const data = "x".repeat(size);
      const parts = chunk(data);
      expect(parts.length).toBe(count);
      parts.forEach((p, i) => {
        expect(p[0]).toBe(i === parts.length - 1 ? TYPE_FINAL : TYPE_CONTINUATION);
        expect(p.length).toBeLessThanOrEqual(MAX_CHUNK + 1);
      });
      expect(parts.reduce((n, p) => n + p.length - 1, 0)).toBe(size);
      expect(roundTrip(data)).toBe(data);
    }
  });

  test("an empty string is one final chunk with no content", () => {
    const parts = chunk("");
    expect(parts.map((p) => Array.from(p))).toEqual([[TYPE_FINAL]]);
    expect(roundTrip("")).toBe("");
  });

  test("bytes are split, not characters: a multi-byte character across a boundary survives", () => {
    const across = `${"a".repeat(MAX_CHUNK - 1)}€tail`;
    expect(chunk(across).length).toBe(2);
    expect(roundTrip(across)).toBe(across);
    // Every chunk is bounded in BYTES, even when every character is 3 bytes.
    const wide = "€".repeat(70_000);
    for (const p of chunk(wide)) expect(p.length).toBeLessThanOrEqual(MAX_CHUNK + 1);
    expect(roundTrip(wide)).toBe(wide);
    const astral = "😀".repeat(40_000);
    expect(roundTrip(astral)).toBe(astral);
  });

  test("a reassembler yields one message per final, then starts afresh", () => {
    const r = new Reassembler(100);
    expect(r.push(Uint8Array.of(TYPE_CONTINUATION, 0x61))).toBeNull();
    expect(r.push(Uint8Array.of(TYPE_FINAL, 0x62))).toBe("ab");
    expect(r.push(Uint8Array.of(TYPE_FINAL, 0x63))).toBe("c");
  });

  test("unknown type, a confirm in transport, and an empty plaintext are violations", () => {
    badFrame(() => new Reassembler(100).push(Uint8Array.of(3, 0x61)));
    badFrame(() => new Reassembler(100).push(Uint8Array.of(0xff)));
    badFrame(() => new Reassembler(100).push(Uint8Array.of(TYPE_CONFIRM)));
    badFrame(() => new Reassembler(100).push(new Uint8Array(0)));
  });

  test("the cap: exactly max passes, max + 1 is refused", () => {
    const ok = new Reassembler(10);
    expect(ok.push(Uint8Array.of(TYPE_CONTINUATION, ...ascii("12345")))).toBeNull();
    expect(ok.push(Uint8Array.of(TYPE_FINAL, ...ascii("67890")))).toBe("1234567890");
    const over = new Reassembler(10);
    expect(over.push(Uint8Array.of(TYPE_CONTINUATION, ...ascii("12345")))).toBeNull();
    expect(
      badFrame(() => over.push(Uint8Array.of(TYPE_FINAL, ...ascii("678901")))).message,
    ).toContain("exceeds");
    badFrame(() => roundTrip("x".repeat(11), 10));
    expect(roundTrip("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});
