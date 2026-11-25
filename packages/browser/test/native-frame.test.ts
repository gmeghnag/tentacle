import { describe, expect, test } from "bun:test";
import { HOST_TO_CHROME_MAX_BYTES, NativeDecoder, encodeNative } from "../src/index.ts";

function collect(le: boolean, max?: number) {
  const messages: unknown[] = [];
  const violations: string[] = [];
  const decoder = new NativeDecoder(
    { onMessage: (m) => messages.push(m), onViolation: (r) => violations.push(r) },
    le,
    ...(max === undefined ? [] : [max]),
  );
  return { decoder, messages, violations };
}

describe("native messaging framing (F3/F4)", () => {
  for (const le of [true, false]) {
    test(`round-trip, ${le ? "little" : "big"}-endian length`, () => {
      const bytes = encodeNative({ id: 1, text: "ciao ✓" }, le);
      // The length prefix really is in the requested byte order.
      expect(new DataView(bytes.buffer).getUint32(0, le)).toBe(bytes.length - 4);
      const { decoder, messages } = collect(le);
      decoder.push(bytes);
      expect(messages).toEqual([{ id: 1, text: "ciao ✓" }]);
    });
  }

  test("a message split at every byte boundary, and two glued together, decode", () => {
    const a = encodeNative({ n: 1 }, true);
    const b = encodeNative({ n: 2 }, true);
    const { decoder, messages } = collect(true);
    for (const byte of a) decoder.push(new Uint8Array([byte]));
    const glued = new Uint8Array(b.length * 2);
    glued.set(b, 0);
    glued.set(b, b.length);
    decoder.push(glued);
    expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 2 }]);
  });

  test("host → Chrome: exactly 1 MB passes, 1 MB + 1 is refused locally", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ s: "" })).length;
    const ok = { s: "a".repeat(HOST_TO_CHROME_MAX_BYTES - overhead) };
    expect(encodeNative(ok).length).toBe(4 + HOST_TO_CHROME_MAX_BYTES);
    expect(() => encodeNative({ s: `${ok.s}a` })).toThrow(/1 MB/);
  });

  test("Chrome → host: a length over the cap kills the decoder; nothing after is parsed", () => {
    const { decoder, messages, violations } = collect(true, 16);
    decoder.push(encodeNative({ s: "x".repeat(100) }, true));
    expect(violations).toHaveLength(1);
    expect(decoder.dead).toBe(true);
    decoder.push(encodeNative({ n: 1 }, true));
    expect(messages).toEqual([]);
    expect(violations).toHaveLength(1);
  });

  test("a body that is not JSON is a violation", () => {
    const body = new TextEncoder().encode("not json");
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, true);
    frame.set(body, 4);
    const { decoder, violations } = collect(true);
    decoder.push(frame);
    expect(violations).toEqual(["message is not JSON"]);
  });
});
