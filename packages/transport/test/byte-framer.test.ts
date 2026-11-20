import { describe, expect, test } from "bun:test";
import {
  ByteFramer,
  type FramerViolation,
  MAX_STREAM_LINE_BYTES,
  describeViolation,
} from "../src/byte-framer.ts";
import { INITIATOR_MAX_MESSAGE_BYTES } from "../src/noise-channel.ts";

const enc = new TextEncoder();

function framer(max = 16) {
  const lines: string[] = [];
  const violations: FramerViolation[] = [];
  const f = new ByteFramer(
    { onLine: (l) => lines.push(l), onViolation: (v) => violations.push(v) },
    max,
  );
  return {
    f,
    lines,
    violations,
    push: (s: string | Uint8Array) => f.push(typeof s === "string" ? enc.encode(s) : s),
  };
}

describe("ByteFramer", () => {
  test("the default cap is the Noise initiator's (one value laptop-side)", () => {
    expect(MAX_STREAM_LINE_BYTES).toBe(INITIATOR_MAX_MESSAGE_BYTES);
  });

  test("splits lines across chunks and skips blank lines", () => {
    const t = framer();
    t.push('{"a":');
    expect(t.lines).toEqual([]);
    t.push('1}\n\n{"b":2}\n{"c"');
    t.push(":3}\n");
    expect(t.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(t.violations).toEqual([]);
  });

  test("a line of exactly the cap is delivered", () => {
    const t = framer();
    t.push(`${"x".repeat(16)}\n`);
    t.push("y".repeat(8));
    t.push(`${"y".repeat(8)}\n`);
    expect(t.lines).toEqual(["x".repeat(16), "y".repeat(16)]);
    expect(t.violations).toEqual([]);
  });

  test("one byte over the cap is a violation as it arrives, before any newline", () => {
    const t = framer();
    t.push("x".repeat(16));
    expect(t.violations).toEqual([]);
    t.push("x");
    expect(t.violations).toEqual([{ kind: "line-too-long", limit: 16 }]);
    expect(t.f.dead).toBe(true);
  });

  test("one byte over the cap in a complete line is a violation too", () => {
    const t = framer();
    t.push(`${"x".repeat(17)}\n`);
    expect(t.lines).toEqual([]);
    expect(t.violations).toEqual([{ kind: "line-too-long", limit: 16 }]);
  });

  test("a huge chunk with no newline is refused on that push", () => {
    const t = framer(1024);
    t.push(new Uint8Array(10 * 1024 * 1024).fill(0x61));
    expect(t.violations).toEqual([{ kind: "line-too-long", limit: 1024 }]);
  });

  test("many small chunks with no newline: refused on the one that crosses the cap", () => {
    const t = framer();
    for (let i = 0; i < 16; i++) {
      t.push("x");
    }
    expect(t.violations).toEqual([]);
    t.push("x");
    expect(t.violations).toHaveLength(1);
  });

  test("lines before a violation in the same chunk are delivered; nothing after it", () => {
    const t = framer();
    t.push(`{"a":1}\n${"x".repeat(17)}\n{"b":2}\n`);
    expect(t.lines).toEqual(['{"a":1}']);
    expect(t.violations).toHaveLength(1);
  });

  test("a valid frame after a violation is never delivered (dead, not a fragment)", () => {
    const t = framer();
    t.push("x".repeat(17));
    t.push('\n{"a":1}\n');
    t.push('{"b":2}\n');
    expect(t.lines).toEqual([]);
    expect(t.violations).toHaveLength(1); // reported once
  });

  test("a multi-byte UTF-8 char split across chunks is decoded intact", () => {
    const t = framer();
    const bytes = enc.encode("aé€😀\n"); // 1 + 2 + 3 + 4 bytes + \n
    for (const b of bytes) {
      t.push(new Uint8Array([b]));
    }
    expect(t.lines).toEqual(["aé€😀"]);
  });

  test("the cap counts bytes: a split char that ends exactly at the cap passes, one more byte fails", () => {
    // 12 ASCII + a 4-byte emoji = 16 bytes, the emoji split 2 + 2 across chunks.
    const emoji = enc.encode("😀");
    const ok = framer();
    ok.push(`${"a".repeat(12)}`);
    ok.push(emoji.subarray(0, 2));
    ok.push(emoji.subarray(2));
    ok.push("\n");
    expect(ok.lines).toEqual([`${"a".repeat(12)}😀`]);
    expect(ok.violations).toEqual([]);

    const over = framer();
    over.push(`${"a".repeat(13)}`);
    over.push(emoji.subarray(0, 2));
    over.push(emoji.subarray(2)); // byte 17: over
    expect(over.violations).toEqual([{ kind: "line-too-long", limit: 16 }]);
  });

  test("a line starting with NUL is the reserved tag (BF3), whatever chunk it lands in", () => {
    const a = framer();
    a.push(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]));
    expect(a.violations).toEqual([{ kind: "reserved-tag" }]);

    const b = framer();
    b.push('{"a":1}\n');
    b.push(new Uint8Array([0x00]));
    b.push('{"b":2}\n');
    expect(b.lines).toEqual(['{"a":1}']);
    expect(b.violations).toEqual([{ kind: "reserved-tag" }]);
  });

  test("a held tail is copied: a producer reusing its buffer cannot corrupt it", () => {
    const t = framer();
    const pool = new Uint8Array(4);
    pool.set(enc.encode('{"a"'));
    t.push(pool);
    pool.set(enc.encode("XXXX")); // the producer reuses its read buffer
    t.push(":1}\n");
    expect(t.lines).toEqual(['{"a":1}']);
  });

  test("describeViolation names the source and the bound", () => {
    expect(describeViolation({ kind: "line-too-long", limit: 16 }, "pod stdout")).toBe(
      "pod stdout line exceeds 16 bytes with no newline (frame cap); channel closed",
    );
    expect(describeViolation({ kind: "reserved-tag" }, "pod stdout")).toBe(
      "pod stdout sent a reserved frame tag (0x00); channel closed",
    );
  });

  test("fuzz: random lines around the cap, random chunking = a reference split", () => {
    let seed = 0x9e3779b9;
    const rand = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = ["a", "é", "€", "😀"];
    for (let round = 0; round < 300; round++) {
      const max = 8 + rand(24);
      const lines: string[] = [];
      for (let i = 0, count = 1 + rand(6); i < count; i++) {
        let line = "";
        while (enc.encode(line).length < max - 4 + rand(10)) {
          line += alphabet[rand(alphabet.length)];
        }
        lines.push(line);
      }
      const bytes = enc.encode(`${lines.join("\n")}\n`);
      const t = framer(max);
      for (let at = 0; at < bytes.length; ) {
        const n = 1 + rand(7);
        t.push(bytes.subarray(at, at + n));
        at += n;
      }
      const firstBad = lines.findIndex((l) => enc.encode(l).length > max);
      const expected = firstBad === -1 ? lines : lines.slice(0, firstBad);
      expect(t.lines).toEqual(expected.filter((l) => l !== ""));
      expect(t.violations).toHaveLength(firstBad === -1 ? 0 : 1);
    }
  });
});
