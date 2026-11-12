import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES, checkAttachmentRefs } from "@tentacle/core";
import {
  type FileProbe,
  type ProbedStat,
  baseName,
  collectAttachments,
  inspectPath,
  nodeFileProbe,
  refName,
  refsOf,
  refusalLines,
  sha256Hex,
} from "../src/attach-files.ts";
import { refusalText } from "../src/attach-refusal.ts";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63];
const PDF = [..."%PDF-1.7\n"].map((c) => c.charCodeAt(0));

/** `length` bytes: `head`, then zero padding to the exact size. */
function sized(head: number[], length: number): Uint8Array {
  const out = new Uint8Array(Math.max(length, head.length));
  out.set(head, 0);
  return out;
}

interface FakeEntry {
  readonly kind: "file" | "directory" | "other";
  readonly bytes?: Uint8Array;
  /** Force a size other than the bytes' length (an over-cap file with no 15 MB buffer). */
  readonly size?: number;
  /** Make `stat` throw (an unsearchable parent directory). */
  readonly statError?: boolean;
  /** Make `read` throw (permissions). */
  readonly readError?: boolean;
}

/**
 * A `FileProbe` over a map: no real file system, and `read` honours the cap the
 * way a real one does (at most `maxBytes`, fewer at EOF).
 */
function fakeProbe(entries: Record<string, FakeEntry>): FileProbe {
  return {
    async stat(path) {
      const entry = entries[path];
      if (entry === undefined) {
        return null;
      }
      if (entry.statError === true) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      const result: ProbedStat = {
        kind: entry.kind,
        size: entry.size ?? entry.bytes?.length ?? 0,
      };
      return result;
    },
    async read(path, maxBytes) {
      const entry = entries[path];
      if (entry === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      if (entry.readError === true) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      const bytes = entry.bytes ?? new Uint8Array(entry.size ?? 0);
      return bytes.subarray(0, maxBytes);
    },
  };
}

describe("inspectPath — the happy path", () => {
  test("builds a content-addressed ref: id = sha256 of the bytes, type from the bytes", async () => {
    const bytes = sized(PNG_SIG, 128);
    const probe = fakeProbe({ "/a/Shot 1.png": { kind: "file", bytes } });
    const result = await inspectPath(probe, "/a/Shot 1.png");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.image.ref).toEqual({
      id: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "image/png",
      size: 128,
      name: "Shot 1.png",
    });
    expect(result.image.bytes.length).toBe(128);
    // What this produced must pass the wire's own entry check (one cap, not two).
    expect(() => checkAttachmentRefs([result.image.ref])).not.toThrow();
  });

  test("the TYPE comes from the bytes, not the name: PNG bytes named .heic are image/png", async () => {
    const probe = fakeProbe({ "/a/mislabelled.heic": { kind: "file", bytes: sized(PNG_SIG, 64) } });
    const result = await inspectPath(probe, "/a/mislabelled.heic");
    expect(result.ok && result.image.ref.mimeType).toBe("image/png");
  });

  test("the TYPE comes from the bytes: JPEG/GIF/WebP all pass", async () => {
    const jpeg = [0xff, 0xd8, 0xff, 0xe0];
    const gif = [..."GIF89a"].map((c) => c.charCodeAt(0));
    const webp = new Uint8Array(16);
    webp.set(
      [..."RIFF"].map((c) => c.charCodeAt(0)),
      0,
    );
    webp.set(
      [..."WEBP"].map((c) => c.charCodeAt(0)),
      8,
    );
    const probe = fakeProbe({
      "/a/x.jpg": { kind: "file", bytes: sized(jpeg, 64) },
      "/a/y.gif": { kind: "file", bytes: sized(gif, 64) },
      "/a/z.webp": { kind: "file", bytes: webp },
    });
    expect((await inspectPath(probe, "/a/x.jpg")).ok).toBe(true);
    expect((await inspectPath(probe, "/a/y.gif")).ok).toBe(true);
    const result = await inspectPath(probe, "/a/z.webp");
    expect(result.ok && result.image.ref.mimeType).toBe("image/webp");
  });

  test("a path with no basename (the root) drops the name", async () => {
    const probe = fakeProbe({ "/": { kind: "file", bytes: sized(PNG_SIG, 32) } });
    const result = await inspectPath(probe, "/");
    expect(result.ok).toBe(true);
    expect(result.ok && "name" in result.image.ref).toBe(false);
  });
});

describe("inspectPath — every failure mode", () => {
  test("nonexistent path → not-found", async () => {
    const result = await inspectPath(fakeProbe({}), "/a/nope.png");
    expect(result).toEqual({ ok: false, refusal: { reason: "not-found", path: "/a/nope.png" } });
    expect(refusalText({ reason: "not-found", path: "/a/nope.png" })).toContain("no such file");
  });

  test("a directory → directory, and nothing is read", async () => {
    let reads = 0;
    const probe = fakeProbe({ "/a/dir": { kind: "directory" } });
    const counting: FileProbe = {
      stat: probe.stat,
      read: (path, max) => {
        reads += 1;
        return probe.read(path, max);
      },
    };
    const result = await inspectPath(counting, "/a/dir");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.reason).toBe("directory");
    expect(reads).toBe(0);
  });

  test("a fifo/device is refused by kind, never read (it could block forever)", async () => {
    const result = await inspectPath(fakeProbe({ "/a/fifo": { kind: "other" } }), "/a/fifo");
    expect(result.ok === false && result.refusal.reason).toBe("not-file");
  });

  test("an unreadable file → unreadable (from the read rejection)", async () => {
    const probe = fakeProbe({
      "/a/x.png": { kind: "file", bytes: sized(PNG_SIG, 64), readError: true },
    });
    const result = await inspectPath(probe, "/a/x.png");
    expect(result.ok === false && result.refusal.reason).toBe("unreadable");
  });

  test("a stat that throws (unsearchable parent) → unreadable", async () => {
    const probe = fakeProbe({ "/a/x.png": { kind: "file", statError: true } });
    const result = await inspectPath(probe, "/a/x.png");
    expect(result.ok === false && result.refusal.reason).toBe("unreadable");
  });

  test("an empty file → empty, never 'not-image'", async () => {
    const probe = fakeProbe({ "/a/empty.png": { kind: "file", bytes: new Uint8Array(0) } });
    const result = await inspectPath(probe, "/a/empty.png");
    expect(result.ok === false && result.refusal.reason).toBe("empty");
    expect(refusalText({ reason: "empty", path: "/a/empty.png" })).toContain("empty (0 bytes)");
  });

  test("HEIC is RECOGNISED and refused with a convert remedy, not 'not an image'", async () => {
    const probe = fakeProbe({ "/a/IMG_0001.HEIC": { kind: "file", bytes: sized(HEIC, 64) } });
    const result = await inspectPath(probe, "/a/IMG_0001.HEIC");
    expect(result.ok === false && result.refusal.reason).toBe("heic");
    const text = refusalText({ reason: "heic", path: "/a/IMG_0001.HEIC" });
    expect(text).toContain("HEIC/HEIF");
    expect(text).toContain("sips -s format png");
    expect(text).not.toContain("not a PNG");
  });

  test("a non-image (PDF, text) → not-image, and it is NEVER named by extension", async () => {
    const probe = fakeProbe({
      "/a/doc.png": { kind: "file", bytes: sized(PDF, 64) },
      "/a/notes.txt": {
        kind: "file",
        bytes: sized(
          [..."hi\n"].map((c) => c.charCodeAt(0)),
          8,
        ),
      },
    });
    const renamed = await inspectPath(probe, "/a/doc.png");
    expect(renamed.ok === false && renamed.refusal.reason).toBe("not-image");
    expect(refusalText({ reason: "not-image", path: "/a/doc.png" })).toContain(
      "not a PNG, JPEG, GIF or WebP",
    );
    expect((await inspectPath(probe, "/a/notes.txt")).ok).toBe(false);
  });

  test("a full read is not attempted for a non-image: only the head is read", async () => {
    const reads: number[] = [];
    const probe = fakeProbe({ "/a/doc.png": { kind: "file", bytes: sized(PDF, 64) } });
    const counting: FileProbe = {
      stat: probe.stat,
      read: (path, max) => {
        reads.push(max);
        return probe.read(path, max);
      },
    };
    await inspectPath(counting, "/a/doc.png");
    expect(reads).toEqual([12]);
  });
});

describe("the size cap (MAX_IMAGE_BYTES = 15 MB, owner override)", () => {
  test("exactly at the cap passes", async () => {
    const probe = fakeProbe({
      "/a/big.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES) },
    });
    const result = await inspectPath(probe, "/a/big.png");
    expect(result.ok).toBe(true);
  });

  test("one byte over the cap is refused, naming the size and the limit", async () => {
    const probe = fakeProbe({
      "/a/big.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES + 1) },
    });
    const result = await inspectPath(probe, "/a/big.png");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a refusal");
    }
    expect(result.refusal).toEqual({
      reason: "too-large",
      path: "/a/big.png",
      size: MAX_IMAGE_BYTES + 1,
    });
    const text = refusalText(result.refusal);
    expect(text).toContain("15 MB");
    expect(text).toContain("/a/big.png");
  });

  test("an over-cap file reported by stat is refused BEFORE any read", async () => {
    const reads: number[] = [];
    const probe = fakeProbe({ "/a/huge.png": { kind: "file", size: MAX_IMAGE_BYTES * 4 } });
    const counting: FileProbe = {
      stat: probe.stat,
      read: (path, max) => {
        reads.push(max);
        return probe.read(path, max);
      },
    };
    const result = await inspectPath(counting, "/a/huge.png");
    expect(result.ok === false && result.refusal.reason).toBe("too-large");
    expect(reads).toEqual([]);
  });

  test("a file that grew past the cap after stat is caught, not read whole", async () => {
    // stat says 100 bytes; the bytes are actually MAX+1 (a growing download).
    const probe = fakeProbe({
      "/a/growing.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES + 1), size: 100 },
    });
    const result = await inspectPath(probe, "/a/growing.png");
    expect(result.ok === false && result.refusal.reason).toBe("too-large");
  });

  test("the cap is the wire's constant, not a local re-declaration", () => {
    expect(MAX_IMAGE_BYTES).toBe(15 * 1024 * 1024);
    expect(refusalText({ reason: "too-large", path: "x", size: MAX_IMAGE_BYTES + 1 })).toContain(
      "15 MB",
    );
  });
});

describe("collectAttachments", () => {
  const image = (seed: number): Uint8Array => {
    const bytes = sized(PNG_SIG, 40);
    bytes[20] = seed;
    return bytes;
  };

  test("keeps the images that pass and reports the ones that do not", async () => {
    const probe = fakeProbe({
      "/a/one.png": { kind: "file", bytes: image(1) },
      "/a/bad.png": { kind: "file", bytes: sized(PDF, 40) },
      "/a/two.png": { kind: "file", bytes: image(2) },
    });
    const collected = await collectAttachments(probe, ["/a/one.png", "/a/bad.png", "/a/two.png"]);
    expect(collected.images.map((i) => i.path)).toEqual(["/a/one.png", "/a/two.png"]);
    expect(collected.refusals.map((r) => r.reason)).toEqual(["not-image"]);
    // The refs it produced are exactly what the wire accepts.
    expect(() => checkAttachmentRefs(refsOf(collected))).not.toThrow();
    expect(refusalLines(collected)[0]).toContain("/a/bad.png");
  });

  test("the 6th image is refused by the wire's per-message cap; the first 5 stay", async () => {
    const entries: Record<string, FakeEntry> = {};
    const paths: string[] = [];
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE + 1; i += 1) {
      const path = `/a/${i}.png`;
      entries[path] = { kind: "file", bytes: image(i + 1) };
      paths.push(path);
    }
    const collected = await collectAttachments(fakeProbe(entries), paths);
    expect(collected.images.length).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(collected.refusals).toEqual([
      { reason: "too-many", count: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
    ]);
    expect(refusalLines(collected)[0]).toContain("5 images per message");
  });

  test("the same file twice is refused as a duplicate, never attached twice", async () => {
    const bytes = image(7);
    const probe = fakeProbe({
      "/a/one.png": { kind: "file", bytes },
      "/a/copy.png": { kind: "file", bytes },
    });
    const collected = await collectAttachments(probe, ["/a/one.png", "/a/copy.png"]);
    expect(collected.images.map((i) => i.path)).toEqual(["/a/one.png"]);
    expect(collected.refusals).toEqual([{ reason: "duplicate", path: "/a/copy.png" }]);
    // A duplicate would also be refused by the wire — this is why it is caught here.
    expect(() => checkAttachmentRefs([...refsOf(collected), ...refsOf(collected)])).toThrow();
  });

  test("an empty candidate list attaches nothing and says nothing", async () => {
    const collected = await collectAttachments(fakeProbe({}), []);
    expect(collected).toEqual({ images: [], refusals: [] });
  });

  test("every refusal has an actionable, one-line text naming its subject", async () => {
    const probe = fakeProbe({
      "/a/dir": { kind: "directory" },
      "/a/empty.png": { kind: "file", bytes: new Uint8Array(0) },
      "/a/heic.HEIC": { kind: "file", bytes: sized(HEIC, 40) },
      "/a/big.png": { kind: "file", size: MAX_IMAGE_BYTES + 1 },
      "/a/doc.png": { kind: "file", bytes: sized(PDF, 40) },
      "/a/denied.png": { kind: "file", bytes: image(9), readError: true },
      "/a/fifo": { kind: "other" },
    });
    const paths = [
      "/a/dir",
      "/a/empty.png",
      "/a/heic.HEIC",
      "/a/big.png",
      "/a/doc.png",
      "/a/denied.png",
      "/a/fifo",
      "/a/missing.png",
    ];
    const collected = await collectAttachments(probe, paths);
    expect(collected.images).toEqual([]);
    const lines = refusalLines(collected);
    expect(lines.length).toBe(paths.length);
    for (const [index, line] of lines.entries()) {
      const path = paths[index] ?? "";
      expect(line).toContain(path);
      expect(line.includes("\n")).toBe(false);
    }
  });
});

describe("helpers", () => {
  test("baseName handles POSIX, Windows and a trailing slash", () => {
    expect(baseName("/a/b/c.png")).toBe("c.png");
    expect(baseName("C:\\Users\\me\\c.png")).toBe("c.png");
    expect(baseName("/a/dir/")).toBe("dir");
  });

  test("refName drops control characters and caps the length", () => {
    expect(refName("/a/ok.png")).toBe("ok.png");
    expect(refName("/a/we\u0000ird.png")).toBe("weird.png");
    expect(refName("/a/x\u001by.png")).toBe("xy.png");
    expect(refName("/")).toBeUndefined();
    const long = `/${"n".repeat(300)}.png`;
    expect(refName(long)?.length).toBe(255);
  });

  test("sha256Hex is lowercase hex of the bytes", () => {
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
      createHash("sha256")
        .update(new Uint8Array([1, 2, 3]))
        .digest("hex"),
    );
  });
});

describe("nodeFileProbe — the production seam (one real file, then deleted)", () => {
  test("stat/read agree with the fake's contract, and a missing path is null", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "tentacle-attach-"));
    try {
      const file = join(dir, "Shot 1.png");
      await writeFile(file, sized(PNG_SIG, 100));
      const probe = nodeFileProbe();
      expect(await probe.stat(join(dir, "missing.png"))).toBeNull();
      expect(await probe.stat(dir)).toEqual({ kind: "directory", size: expect.any(Number) });
      const info = await probe.stat(file);
      expect(info).toEqual({ kind: "file", size: 100 });
      // `read` never returns more than asked for, and fewer bytes at EOF.
      expect((await probe.read(file, 12)).length).toBe(12);
      expect((await probe.read(file, 4096)).length).toBe(100);
      const result = await inspectPath(probe, file);
      expect(result.ok && result.image.ref.name).toBe("Shot 1.png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
