import { describe, expect, test } from "bun:test";
/**
 * `ReadWindow` — the pure half of `RemoteClient.readArtifact`
 * (docs/feat/model-artifacts.md D6, T5). The daemon may be a pod (AGENTS §7: not
 * trusted), so the property is: the window hands back the bytes ONLY when every
 * chunk had exactly its expected length, the daemon's `size` matched the meta's,
 * and the whole hashed to the meta's `sha256` — and it never sizes anything from
 * a daemon answer.
 */
import { createHash } from "node:crypto";
import { MAX_ARTIFACT_BYTES } from "@tentacle/protocol";
import { encodeBase64 } from "@tentacle/transport";
import { ArtifactCorruptError, ReadWindow } from "../src/read-window.ts";

const C = 8;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
const reply = (b: Uint8Array, offset: number, size = b.length) => ({
  data: encodeBase64(b.subarray(offset, Math.min(offset + C, b.length))),
  size,
});

/** Drain the window in order, answering each read from `b`. */
function drain(w: ReadWindow, b: Uint8Array): number[] {
  const asked: number[] = [];
  for (;;) {
    const step = w.next();
    if (step.kind === "done") return asked;
    if (step.kind === "wait") throw new Error("drain answers at once; it never waits");
    asked.push(step.offset);
    w.accept(step.offset, reply(b, step.offset));
  }
}

describe("a well-behaved daemon", () => {
  test("offsets 0, C, 2C…, the last chunk short; finish returns the exact bytes", () => {
    const b = bytes(3 * C + 3);
    const w = new ReadWindow(b.length, { chunk: C });
    expect(drain(w, b)).toEqual([0, C, 2 * C, 3 * C]);
    expect(w.have).toBe(b.length);
    expect(Array.from(w.finish(sha(b), sha))).toEqual(Array.from(b));
  });

  test("at most `window` reads out at once (default 2), then wait", () => {
    const w = new ReadWindow(5 * C, { chunk: C });
    expect(w.next()).toEqual({ kind: "read", offset: 0 });
    expect(w.next()).toEqual({ kind: "read", offset: C });
    expect(w.next()).toEqual({ kind: "wait" });
  });

  test("answers out of order still assemble in place", () => {
    const b = bytes(2 * C);
    const w = new ReadWindow(b.length, { chunk: C });
    w.next();
    w.next();
    w.accept(C, reply(b, C));
    w.accept(0, reply(b, 0));
    expect(w.next()).toEqual({ kind: "done" });
    expect(Array.from(w.finish(sha(b), sha))).toEqual(Array.from(b));
  });

  test("rewind after a drop resumes at the first MISSING chunk, never re-reads a held one", () => {
    const b = bytes(6 * C);
    const w = new ReadWindow(b.length, { chunk: C });
    for (const offset of [0, C, 2 * C]) {
      expect(w.next()).toEqual({ kind: "read", offset });
      w.accept(offset, reply(b, offset));
    }
    // Chunks 3 and 4 go out; the link drops before either is answered.
    w.next();
    w.next();
    w.rewind();
    expect(drain(w, b)).toEqual([3 * C, 4 * C, 5 * C]);
    expect(Array.from(w.finish(sha(b), sha))).toEqual(Array.from(b));
  });
});

describe("a hostile daemon (a pod is not trusted)", () => {
  test("a short chunk → ArtifactCorruptError", () => {
    const b = bytes(2 * C);
    const w = new ReadWindow(b.length, { chunk: C });
    w.next();
    expect(() => w.accept(0, { data: encodeBase64(b.subarray(0, C - 1)), size: b.length })).toThrow(
      ArtifactCorruptError,
    );
  });

  test("a long chunk (more than C) → ArtifactCorruptError, nothing written past the buffer", () => {
    const b = bytes(C + 2);
    const w = new ReadWindow(b.length, { chunk: C });
    w.next();
    w.accept(0, reply(b, 0));
    w.next();
    // The last chunk must be 2 bytes; a full chunk would overrun `size`.
    expect(() => w.accept(C, { data: encodeBase64(bytes(C)), size: b.length })).toThrow(
      ArtifactCorruptError,
    );
  });

  test("an answered `size` other than the meta's → ArtifactCorruptError", () => {
    const b = bytes(2 * C);
    const w = new ReadWindow(b.length, { chunk: C });
    w.next();
    expect(() => w.accept(0, reply(b, 0, b.length + 1))).toThrow(ArtifactCorruptError);
  });

  test("right lengths, wrong bytes → finish throws ArtifactCorruptError", () => {
    const b = bytes(2 * C);
    const other = bytes(2 * C).map((x) => x ^ 1);
    const w = new ReadWindow(b.length, { chunk: C });
    drain(w, other);
    expect(() => w.finish(sha(b), sha)).toThrow(ArtifactCorruptError);
  });

  test("non-canonical base64 → ArtifactCorruptError (strict decode)", () => {
    const w = new ReadWindow(1, { chunk: C });
    w.next();
    // "AB==" decodes to one byte but its unused low bits are set: two texts, one byte.
    expect(() => w.accept(0, { data: "AB==", size: 1 })).toThrow(ArtifactCorruptError);
  });

  test("finish before every chunk is in → ArtifactCorruptError", () => {
    const b = bytes(2 * C);
    const w = new ReadWindow(b.length, { chunk: C });
    w.next();
    w.accept(0, reply(b, 0));
    expect(() => w.finish(sha(b), sha)).toThrow(ArtifactCorruptError);
  });
});

describe("the size comes from the meta, bounded", () => {
  test("0, a fraction and > MAX_ARTIFACT_BYTES are refused before any buffer exists", () => {
    expect(() => new ReadWindow(0)).toThrow(RangeError);
    expect(() => new ReadWindow(1.5)).toThrow(RangeError);
    expect(() => new ReadWindow(MAX_ARTIFACT_BYTES + 1)).toThrow(RangeError);
  });
});
