/**
 * `LaptopImages` (docs/feat/attachments-prompt.md D5/D6, T6): the laptop-side
 * byte store a pod's refs resolve against.
 *
 * The property: it holds BYTES (never paths — a screenshot's temp file may be
 * gone), answers only for an id it added itself and only at the exact size
 * (so a hostile or stale ref gets a placeholder, never the wrong image), and
 * refuses loudly when full instead of evicting (an eviction would silently turn
 * an image the user already sent into `[image unavailable]`).
 */
import { describe, expect, test } from "bun:test";
import { LAPTOP_IMAGE_BYTES, LaptopImages, LaptopImagesFullError } from "../src/laptop-images.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const ref = (id: string, size: number): { id: string; mimeType: string; size: number } => ({
  id,
  mimeType: "image/png",
  size,
});

describe("add / read", () => {
  test("a held id reads back exactly its bytes", async () => {
    const images = new LaptopImages();
    const bytes = bytesOf("png");
    images.add("a".repeat(64), bytes);
    expect(await images.read(ref("a".repeat(64), bytes.length))).toEqual(bytes);
  });

  test("an unknown id reads `null` (a pod may name anything)", async () => {
    const images = new LaptopImages();
    expect(await images.read(ref("b".repeat(64), 3))).toBeNull();
  });

  test("a held id at the WRONG size reads `null` (size is checked, not trusted)", async () => {
    const images = new LaptopImages();
    const bytes = bytesOf("png");
    const id = "c".repeat(64);
    images.add(id, bytes);
    expect(await images.read(ref(id, bytes.length + 1))).toBeNull();
    expect(await images.read(ref(id, bytes.length - 1))).toBeNull();
  });
});

describe("dedupe", () => {
  test("adding the same id twice does not double-count", () => {
    const images = new LaptopImages();
    const bytes = bytesOf("same");
    const id = "d".repeat(64);
    images.add(id, bytes);
    images.add(id, bytes);
    expect(images.held).toBe(bytes.length);
    expect(images.count).toBe(1);
  });
});

describe("bounded, and never evicting", () => {
  test("past the cap it throws LaptopImagesFullError and keeps what it had", async () => {
    const images = new LaptopImages({ maxBytes: 8 });
    const first = bytesOf("12345");
    images.add("e".repeat(64), first);
    expect(() => images.add("f".repeat(64), bytesOf("6789"))).toThrow(LaptopImagesFullError);
    // The image the user already sent still resolves.
    expect(await images.read(ref("e".repeat(64), first.length))).toEqual(first);
    expect(images.count).toBe(1);
  });

  test("the default cap is 100 MiB", () => {
    expect(LAPTOP_IMAGE_BYTES).toBe(100 * 1024 * 1024);
  });

  test("a full store refuses LOUDLY: the error names the limit", () => {
    const images = new LaptopImages({ maxBytes: 4 });
    let message = "";
    try {
      images.add("g".repeat(64), bytesOf("12345"));
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("4");
  });
});

describe("the disk fallback, scoped to the sessions this client built (docs/feat/attachments-durable.md T10)", () => {
  /** A laptop store on disk: uid → id → bytes; every fallback call recorded. */
  function disk(files: Record<string, Record<string, Uint8Array>>) {
    const calls: string[] = [];
    const fallback = async (uid: string, r: { id: string }) => {
      calls.push(uid);
      return files[uid]?.[r.id] ?? null;
    };
    return { fallback, calls };
  }
  const png = bytesOf("on disk");
  const ID = "1".repeat(64);

  test("a blob under a session NOT allowed → null, and that session is never asked", async () => {
    const { fallback, calls } = disk({ other: { [ID]: png } });
    const images = new LaptopImages({ fallback });
    images.allowSession("mine");
    expect(await images.read(ref(ID, png.length))).toBeNull();
    expect(calls).toEqual(["mine"]);
  });

  test("an allowed session's blob resolves; first hit wins; a wrong size is null", async () => {
    const { fallback, calls } = disk({ b: { [ID]: png } });
    const images = new LaptopImages({ fallback });
    images.allowSession("a");
    images.allowSession("b");
    images.allowSession("c");
    expect(await images.read(ref(ID, png.length))).toEqual(png);
    expect(calls).toEqual(["a", "b"]);
    expect(await images.read(ref(ID, png.length + 1))).toBeNull();
    // Not cached into memory: `holds` (the attach dedupe) stays memory-only.
    expect(images.holds(ID, png.length)).toBe(false);
  });

  test("a memory hit never asks the disk", async () => {
    const { fallback, calls } = disk({ a: { [ID]: png } });
    const images = new LaptopImages({ fallback });
    images.allowSession("a");
    images.add(ID, png);
    expect(await images.read(ref(ID, png.length))).toEqual(png);
    expect(calls).toEqual([]);
  });

  test("a malformed id never reaches the fallback (no path built from it)", async () => {
    const { fallback, calls } = disk({});
    const images = new LaptopImages({ fallback });
    images.allowSession("a");
    expect(await images.read(ref("../../etc/passwd", 5))).toBeNull();
    expect(await images.read(ref("A".repeat(64), 5))).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a failing fallback is a miss, never a throw", async () => {
    const images = new LaptopImages({
      fallback: async () => {
        throw new Error("EACCES");
      },
    });
    images.allowSession("a");
    expect(await images.read(ref(ID, 3))).toBeNull();
  });
});
