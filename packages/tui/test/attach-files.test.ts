import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES, checkAttachmentRefs } from "@tentacle/core";
import {
  type FileProbe,
  attachPaths,
  baseName,
  collectAttachments,
  decideAttachment,
  inspectPath,
  nodeFileProbe,
  readToEof,
  refName,
  refsOf,
  refusalLines,
  sha256Hex,
} from "../src/attach-files.ts";
import { refusalText } from "../src/attach-refusal.ts";
import { sniffImageType } from "../src/image-sniff.ts";

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
  /** Report a size other than the bytes' length (a file that grew, a short report). */
  readonly size?: number;
  /** Make the ONE call throw: permissions, an unsearchable parent directory. */
  readonly openError?: boolean;
}

/**
 * A `FileProbe` over a map — the seam is ONE call, exactly like the real one, so
 * a test cannot accidentally leave the type and the bytes on two different reads.
 * `read` honours the cap the way a real one does (never more than asked for).
 */
function fakeProbe(entries: Record<string, FakeEntry>): FileProbe {
  return {
    async read(path, cap) {
      const entry = entries[path];
      if (entry === undefined) {
        return null;
      }
      if (entry.openError === true) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      const bytes = entry.bytes ?? new Uint8Array(entry.size ?? 0);
      return { kind: entry.kind, size: entry.size ?? bytes.length, bytes: bytes.subarray(0, cap) };
    },
  };
}

/** A PNG whose bytes differ by `seed`, so two candidates never share a sha256. */
function imageBytes(seed: number): Uint8Array {
  const bytes = sized(PNG_SIG, 40);
  bytes[20] = seed;
  return bytes;
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

  test("a directory → directory, and none of its bytes are taken for an image", async () => {
    const result = await inspectPath(fakeProbe({ "/a/dir": { kind: "directory" } }), "/a/dir");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.reason).toBe("directory");
  });

  test("a fifo/device → not-file, from the handle's kind (nothing is ever read)", async () => {
    const result = await inspectPath(fakeProbe({ "/a/fifo": { kind: "other" } }), "/a/fifo");
    expect(result.ok === false && result.refusal.reason).toBe("not-file");
  });

  test("an unreadable file → unreadable (the open itself throws)", async () => {
    const probe = fakeProbe({
      "/a/x.png": { kind: "file", bytes: sized(PNG_SIG, 64), openError: true },
    });
    const result = await inspectPath(probe, "/a/x.png");
    expect(result.ok === false && result.refusal.reason).toBe("unreadable");
  });

  test("an fstat that throws (unsearchable parent) → unreadable", async () => {
    const probe = fakeProbe({ "/a/x.png": { kind: "file", openError: true } });
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

  test("a non-image is refused from the SAME one buffer — no second read to compare", async () => {
    const calls: number[] = [];
    const probe = fakeProbe({ "/a/doc.png": { kind: "file", bytes: sized(PDF, 64) } });
    const counting: FileProbe = {
      read: (path, cap) => {
        calls.push(cap);
        return probe.read(path, cap);
      },
    };
    const result = await inspectPath(counting, "/a/doc.png");
    expect(result.ok === false && result.refusal.reason).toBe("not-image");
    // ONE read, bounded by the cap: the type cannot describe other bytes.
    expect(calls).toEqual([MAX_IMAGE_BYTES + 1]);
  });
});

describe("inspectPath — one read, one buffer (M2)", () => {
  test("ONE open per candidate: the type and the bytes cannot come from different reads", async () => {
    let opens = 0;
    const probe = fakeProbe({ "/a/one.png": { kind: "file", bytes: imageBytes(3) } });
    const counting: FileProbe = {
      read: (path, cap) => {
        opens += 1;
        return probe.read(path, cap);
      },
    };
    const result = await inspectPath(counting, "/a/one.png");
    expect(result.ok).toBe(true);
    expect(opens).toBe(1);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // The ref describes exactly the buffer returned, and the type is sniffed
    // from it: `size` is the buffer's length and the id its sha256.
    expect(result.image.ref.size).toBe(result.image.bytes.length);
    expect(result.image.ref.id).toBe(sha256Hex(result.image.bytes));
    // The ref's type IS what those bytes sniff as — one buffer, no second read.
    const sniffed = sniffImageType(result.image.bytes);
    if (sniffed.kind !== "image") {
      throw new Error("expected image bytes to sniff as an image");
    }
    const sniffedType: string = sniffed.mimeType;
    expect(sniffedType).toBe(result.image.ref.mimeType);
  });

  test("a file that changed under us is never a PNG ref over non-PNG bytes", async () => {
    // A probe whose ONLY answer is PDF bytes: whatever the caller learned
    // earlier, the type must describe the bytes actually carried.
    const probe = fakeProbe({
      "/a/swapped.png": { kind: "file", bytes: new TextEncoder().encode("%PDF-1.7") },
    });
    const result = await inspectPath(probe, "/a/swapped.png");
    expect(result.ok === false && result.refusal.reason).toBe("not-image");
  });

  test("a short read (file shrank / FUSE) yields the bytes it GOT, never a hole", async () => {
    // size says 5000; only 64 bytes were readable (the rest vanished).
    const probe = fakeProbe({
      "/a/short.png": { kind: "file", bytes: sized(PNG_SIG, 64), size: 5000 },
    });
    const result = await inspectPath(probe, "/a/short.png");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // The ref describes the bytes sent, not what `size` claimed.
    expect(result.image.ref.size).toBe(64);
    expect(result.image.bytes.length).toBe(64);
    expect(() =>
      checkAttachmentRefs(refsOf({ images: [result.image], refusals: [], outcomes: [] })),
    ).not.toThrow();
  });

  test("a growth past the cap is a too-large refusal, not a truncated image", async () => {
    const probe = fakeProbe({
      "/a/grew.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES + 1), size: 10 },
    });
    const result = await inspectPath(probe, "/a/grew.png");
    expect(result.ok === false && result.refusal.reason).toBe("too-large");
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

  test("the cap is checked against the bytes, so a lying stat cannot hide an over-cap file", async () => {
    // A 1 MB report over a 15 MB+1 buffer: the BYTES decide, one read.
    const probe = fakeProbe({
      "/a/huge.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES + 1), size: 1024 },
    });
    const result = await inspectPath(probe, "/a/huge.png");
    expect(result.ok === false && result.refusal.reason).toBe("too-large");
  });

  test("a file that grew past the cap is caught by the one read, not buffered whole", async () => {
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
  const image = imageBytes;

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
    // Every candidate has a disposition, in the order given.
    expect(collected.outcomes.map((o) => o.kind)).toEqual(["image", "refused", "image"]);
  });

  test("the 6th image is refused by the wire's per-message cap; the first 5 stay", async () => {
    const { entries, paths } = imagePaths("a", MAX_ATTACHMENTS_PER_MESSAGE + 1);
    const collected = await collectAttachments(fakeProbe(entries), paths);
    expect(collected.images.length).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    // ONE refusal for the whole paste, naming the total and how many were dropped.
    expect(collected.refusals).toEqual([
      { reason: "too-many", count: MAX_ATTACHMENTS_PER_MESSAGE + 1, dropped: 1 },
    ]);
    expect(refusalLines(collected)[0]).toContain("5 images per message");
  });

  test("M3: 8 candidates give ONE refusal, not three identical ones", async () => {
    const { entries, paths } = imagePaths("b", 8);
    const collected = await collectAttachments(fakeProbe(entries), paths);
    expect(collected.images.length).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(collected.refusals.length).toBe(1);
    expect(collected.refusals).toEqual([{ reason: "too-many", count: 8, dropped: 3 }]);
    expect(refusalLines(collected)[0]).toContain("8 were given, 3 dropped");
  });

  test("M3: the cap holds across paste for the WHOLE message (existing chips count)", async () => {
    const first = imagePaths("c", 3);
    const probe = fakeProbe({ ...first.entries });
    const a = await collectAttachments(probe, first.paths);
    expect(a.images.length).toBe(3);
    const second = imagePaths("d", 3);
    const more = fakeProbe({ ...first.entries, ...second.entries });
    const b = await collectAttachments(more, second.paths, { existing: refsOf(a) });
    // 3 + 2 = 5: the third of the second paste is over the message's cap.
    expect(b.images.length).toBe(2);
    expect(b.refusals).toEqual([{ reason: "too-many", count: 6, dropped: 1 }]);
    // What 3b would send composes into something the wire accepts.
    expect(() => checkAttachmentRefs([...refsOf(a), ...refsOf(b)])).not.toThrow();
  });

  test("M3: the same image dropped in a SECOND paste is a duplicate, not a 6th chip", async () => {
    const shared = image(7);
    const probe = fakeProbe({
      "/a/one.png": { kind: "file", bytes: shared },
      "/a/copy.png": { kind: "file", bytes: shared },
    });
    const first = await collectAttachments(probe, ["/a/one.png"]);
    const second = await collectAttachments(probe, ["/a/copy.png"], { existing: refsOf(first) });
    expect(second.images).toEqual([]);
    expect(second.refusals.map((r) => r.reason)).toEqual(["duplicate"]);
    expect(() => checkAttachmentRefs([...refsOf(first), ...refsOf(second)])).not.toThrow();
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
    expect(collected).toEqual({ images: [], refusals: [], outcomes: [] });
  });

  test("every refusal has an actionable, one-line text naming its subject", async () => {
    const probe = fakeProbe({
      "/a/dir": { kind: "directory" },
      "/a/empty.png": { kind: "file", bytes: new Uint8Array(0) },
      "/a/heic.HEIC": { kind: "file", bytes: sized(HEIC, 40) },
      "/a/big.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES + 1) },
      "/a/doc.png": { kind: "file", bytes: sized(PDF, 40) },
      "/a/denied.png": { kind: "file", bytes: image(9), openError: true },
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

describe("attachPaths — the paste rule (M4, owner Q3 (a): only image paths)", () => {
  const png = (seed: number): Uint8Array => imageBytes(seed);

  test("a paste of ONLY image paths becomes attachments", async () => {
    const probe = fakeProbe({
      "/a/one.png": { kind: "file", bytes: png(1) },
      "/a/two.png": { kind: "file", bytes: png(2) },
    });
    const decision = await attachPaths(probe, ["/a/one.png", "/a/two.png"]);
    expect(decision.kind).toBe("attachments");
    if (decision.kind !== "attachments") {
      throw new Error("expected attachments");
    }
    expect(decision.images.map((i) => i.path)).toEqual(["/a/one.png", "/a/two.png"]);
    expect(decision.refusals).toEqual([]);
    expect(() => checkAttachmentRefs(decision.refs)).not.toThrow();
  });

  test("a MIXED paste (1 PNG + 1 .ts) stays ENTIRELY plain text, with no refusal", async () => {
    const probe = fakeProbe({
      "/a/one.png": { kind: "file", bytes: png(1) },
      "/a/main.ts": { kind: "file", bytes: new TextEncoder().encode("export const x = 1;\n") },
    });
    const decision = await attachPaths(probe, ["/a/one.png", "/a/main.ts"]);
    // A `text` decision carries NO refusals at all: it is the only variant a
    // component may put back into the prompt.
    expect(decision).toEqual({ kind: "text" });
  });

  test("a drag of a source file alone stays text — never 'not a PNG, JPEG…'", async () => {
    const probe = fakeProbe({
      "/Users/me/Desktop/main.ts": { kind: "file", bytes: new TextEncoder().encode("x\n") },
    });
    const decision = await attachPaths(probe, ["/Users/me/Desktop/main.ts"]);
    expect(decision).toEqual({ kind: "text" });
  });

  test("a slash command stays text (it is never a path at submit)", async () => {
    const probe = fakeProbe({});
    for (const command of ["/help", "/clear"]) {
      expect(await attachPaths(probe, [command])).toEqual({ kind: "text" });
    }
  });

  test("a missing path and a directory stay text, with no refusal", async () => {
    const probe = fakeProbe({ "/a/dir": { kind: "directory" } });
    expect(await attachPaths(probe, ["/a/gone.png"])).toEqual({ kind: "text" });
    expect(await attachPaths(probe, ["/a/dir"])).toEqual({ kind: "text" });
    const fifo = fakeProbe({ "/a/fifo": { kind: "other" } });
    expect(await attachPaths(fifo, ["/a/fifo"])).toEqual({ kind: "text" });
  });

  test("an EMPTY paste is text", async () => {
    const decision = await attachPaths(fakeProbe({}), []);
    expect(decision).toEqual({ kind: "text" });
  });
});

describe("refusals for files that ARE images by their bytes (M4)", () => {
  const png = (seed: number): Uint8Array => imageBytes(seed);

  test("HEIC bytes → ONE refusal naming the conversion, and the paste is REFUSED", async () => {
    const probe = fakeProbe({ "/a/IMG_0001.HEIC": { kind: "file", bytes: sized(HEIC, 64) } });
    const decision = await attachPaths(probe, ["/a/IMG_0001.HEIC"]);
    // An IMAGE that could not be attached is never `text` (3b would otherwise
    // put the path back into the prompt, ready to be sent as a literal path).
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected refused");
    }
    expect(decision.refusals.map((r) => r.reason)).toEqual(["heic"]);
    expect(refusalText(decision.refusals[0] ?? { reason: "empty", path: "" })).toContain(
      "HEIC/HEIF",
    );
  });

  test("one good PNG + one HEIC: the PNG is attached AND the HEIC is named (no silent drop)", async () => {
    const probe = fakeProbe({
      "/a/one.png": { kind: "file", bytes: imageBytes(1) },
      "/a/two.heic": { kind: "file", bytes: sized(HEIC, 64) },
    });
    const decision = await attachPaths(probe, ["/a/one.png", "/a/two.heic"]);
    // HEIC IS an image by its bytes: it does not collapse the paste, and it is
    // never dropped silently — the PNG attaches, the HEIC is explained.
    expect(decision.kind).toBe("attachments");
    expect(decision.kind === "attachments" && decision.images.map((i) => i.path)).toEqual([
      "/a/one.png",
    ]);
    expect(decision.kind === "attachments" && decision.refusals.map((r) => r.reason)).toEqual([
      "heic",
    ]);
  });

  test("a LONE over-cap PNG paste is REFUSED (an image, never text)", async () => {
    const probe = fakeProbe({
      "/a/big.png": { kind: "file", bytes: sized(PNG_SIG, MAX_IMAGE_BYTES + 1) },
    });
    const decision = await attachPaths(probe, ["/a/big.png"]);
    expect(decision).toEqual({
      kind: "refused",
      refusals: [{ reason: "too-large", path: "/a/big.png", size: MAX_IMAGE_BYTES + 1 }],
    });
  });

  test("an UNREADABLE image path is a refusal; an unreadable non-image is text", async () => {
    const locked = fakeProbe({ "/a/locked.png": { kind: "file", openError: true } });
    const asImage = await attachPaths(locked, ["/a/locked.png"]);
    expect(asImage.kind === "refused" && asImage.refusals.map((r) => r.reason)).toEqual([
      "unreadable",
    ]);

    const plain = fakeProbe({ "/a/locked.ts": { kind: "file", openError: true } });
    expect(await attachPaths(plain, ["/a/locked.ts"])).toEqual({ kind: "text" });
  });

  test("an EMPTY image path is a refusal; an empty non-image is text", async () => {
    const empty = new Uint8Array(0);
    const image = await attachPaths(fakeProbe({ "/a/empty.png": { kind: "file", bytes: empty } }), [
      "/a/empty.png",
    ]);
    expect(image.kind === "refused" && image.refusals.map((r) => r.reason)).toEqual(["empty"]);

    const other = await attachPaths(fakeProbe({ "/a/empty.txt": { kind: "file", bytes: empty } }), [
      "/a/empty.txt",
    ]);
    expect(other).toEqual({ kind: "text" });
  });

  test("a RE-DROPPED duplicate is REFUSED, never text (nothing became a chip)", async () => {
    const probe = fakeProbe({ "/a/one.png": { kind: "file", bytes: png(4) } });
    const first = await attachPaths(probe, ["/a/one.png"]);
    if (first.kind !== "attachments") {
      throw new Error("expected attachments");
    }
    const again = await attachPaths(probe, ["/a/one.png"], { existing: first.refs });
    expect(again.kind).toBe("refused");
    expect(again.kind === "refused" && again.refusals.map((r) => r.reason)).toEqual(["duplicate"]);
  });

  test("too-many: one refusal, naming how many were dropped", async () => {
    const full = imagePaths("f", MAX_ATTACHMENTS_PER_MESSAGE - 1);
    const first = await attachPaths(fakeProbe(full.entries), full.paths);
    if (first.kind !== "attachments") {
      throw new Error("expected attachments");
    }
    const over = imagePaths("e", 3);
    const probe = fakeProbe({ ...full.entries, ...over.entries });
    const decision = await attachPaths(probe, over.paths, { existing: first.refs });
    // 4 attached + 3 given = 7; only 1 more fits → 1 attaches, 2 dropped, ONE sentence.
    expect(decision.kind === "attachments" && decision.images.length).toBe(1);
    expect(decision.kind === "attachments" && decision.refusals).toEqual([
      { reason: "too-many", count: 7, dropped: 2 },
    ]);
  });
});

describe("decideAttachment — the ONE decision 3b consumes (M4)", () => {
  test("images only → attachments, refs and no refusal", async () => {
    const probe = fakeProbe({ "/a/one.png": { kind: "file", bytes: imageBytes(1) } });
    const decision = await decideAttachment(probe, { kind: "paths", paths: ["/a/one.png"] });
    expect(decision.kind).toBe("attachments");
    expect(decision.kind === "attachments" && decision.refs.length).toBe(1);
  });

  test("a non-path candidate never reads the disk: it is text at once", async () => {
    let reads = 0;
    const counting: FileProbe = {
      read: (path, cap) => {
        reads += 1;
        return fakeProbe({}).read(path, cap);
      },
    };
    const decision = await decideAttachment(counting, { kind: "text" });
    expect(decision).toEqual({ kind: "text" });
    expect(reads).toBe(0);
  });

  test("a FAILED `/attach` is REFUSED, never text (nothing is put back in the input)", async () => {
    const probe = fakeProbe({});
    const decision = await decideAttachment(
      probe,
      { kind: "paths", paths: ["/a/gone.png"] },
      { explicit: true },
    );
    // The regression: a failed `/attach` was `text`, so 3b re-inserted the
    // literal command into the prompt ready to be sent to the model.
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" && decision.refusals.map((r) => r.reason)).toEqual([
      "not-found",
    ]);
  });

  test("`/attach` of a non-image file IS a refusal (the user said 'a file')", async () => {
    const probe = fakeProbe({
      "/a/main.ts": { kind: "file", bytes: new TextEncoder().encode("x\n") },
    });
    const decision = await decideAttachment(
      probe,
      { kind: "paths", paths: ["/a/main.ts"] },
      { explicit: true },
    );
    expect(decision.kind === "refused" && decision.refusals.map((r) => r.reason)).toEqual([
      "not-image",
    ]);
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

  test("M1: a C1 control character (NEL) is dropped by the WIRE's own rule", () => {
    // `\u0085` is `Cc` but NOT C0/DEL: a narrower local filter kept it, and
    // `checkAttachmentRefs` then threw on the WHOLE message.
    expect(refName("/a/x\u0085y.png")).toBe("xy.png");
    expect(refName("/a/x\u009by.png")).toBe("xy.png");
    // A basename that is ONLY a control character leaves nothing usable.
    expect(refName("/a/\u0085")).toBeUndefined();
  });

  test("the length cap cuts on a code POINT, never through an emoji", () => {
    // 254 BMP chars + one astral char: the 255th UTF-16 unit is the emoji's high
    // surrogate, so a `slice(0, 255)` cut left a LONE surrogate in the name —
    // and `attachmentLabel`/a placeholder then rendered a replacement glyph.
    const emoji = "\u{1F600}";
    const name = refName(`/${"a".repeat(254)}${emoji}.png`);
    // Dropped whole, never half: what came back is exactly the 254 `a`s.
    expect(name).toBe("a".repeat(254));
    expect(name?.includes("\uFFFD")).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name ?? "")).toBe(false);
    // And a name of astral characters stays inside the wire's own bound.
    const astral = refName(`/${"\u{1F600}".repeat(200)}.png`);
    expect((astral ?? "").length).toBeLessThanOrEqual(255);
    expect(astral).toBe("\u{1F600}".repeat(127));
    expect(() =>
      checkAttachmentRefs([
        { id: sha256Hex(imageBytes(9)), mimeType: "image/png", size: 40, name: astral ?? "x" },
      ]),
    ).not.toThrow();
  });

  test("sha256Hex is lowercase hex of the bytes", () => {
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
      createHash("sha256")
        .update(new Uint8Array([1, 2, 3]))
        .digest("hex"),
    );
  });
});

describe("the entry point and the wire agree (M1)", () => {
  test("a C1 name never reaches Session.send: every produced ref passes checkAttachmentRefs", async () => {
    const probe = fakeProbe({ "/a/x\u0085y.png": { kind: "file", bytes: imageBytes(1) } });
    const collected = await collectAttachments(probe, ["/a/x\u0085y.png"]);
    expect(collected.images.length).toBe(1);
    // The regression: this threw "a name carries no control character".
    expect(() => checkAttachmentRefs(refsOf(collected))).not.toThrow();
    expect(collected.images[0]?.ref.name).toBe("xy.png");
  });
});

describe("nodeFileProbe — the production seam (one real file, then deleted)", () => {
  test("readToEof loops: a probe that short-reads yields EVERY byte, not the first chunk", async () => {
    // A FUSE/network mount answers short reads. One read returns 3 bytes; the
    // real file is 10. A single `read` would sniff a truncated head and hash it.
    const whole = new Uint8Array([...PNG_SIG, 0xaa, 0xbb]);
    let served = 0;
    const reader = {
      async read(buffer: Uint8Array, offset: number, length: number, position: number) {
        // Honour the offset the caller asked for, so a loop that does not advance
        // its position re-reads the same 3 bytes forever (and the test hangs red).
        expect(position).toBe(served);
        const bytesRead = Math.min(3, length, whole.length - served);
        buffer.set(whole.subarray(served, served + bytesRead), offset);
        served += bytesRead;
        return { bytesRead };
      },
    };
    expect(Array.from(await readToEof(reader, 4096))).toEqual(Array.from(whole));
    expect(served).toBe(whole.length);
    // EOF stops the loop, not a full buffer: 0 bytes read is done, not an error.
    const empty = {
      read: async () => ({ bytesRead: 0 }),
    };
    expect((await readToEof(empty, 4096)).length).toBe(0);
    // The cap bounds it, and an exact-cap file raises no extra read.
    let reads = 0;
    const capped = {
      async read(buffer: Uint8Array, offset: number, length: number) {
        reads += 1;
        const bytesRead = Math.min(length, 4);
        buffer.set(new Uint8Array(bytesRead).fill(7), offset);
        return { bytesRead };
      },
    };
    expect((await readToEof(capped, 12)).length).toBe(12);
    expect(reads).toBe(3);
  });
  test("one call gives the kind, the size and every byte; a missing path is null", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "tentacle-attach-"));
    try {
      const file = join(dir, "Shot 1.png");
      await writeFile(file, sized(PNG_SIG, 100));
      const probe = nodeFileProbe();
      expect(await probe.read(join(dir, "missing.png"), 4096)).toBeNull();
      // A directory is a kind of its own: refused as `directory`, never read.
      expect(await probe.read(dir, 4096)).toEqual({
        kind: "directory",
        size: expect.any(Number),
        bytes: new Uint8Array(0),
      });
      const info = await probe.read(file, 4096);
      expect(info).toEqual({ kind: "file", size: 100, bytes: sized(PNG_SIG, 100) });
      // Bounded by the cap the caller asked for, never more.
      expect((await probe.read(file, 12))?.bytes.length).toBe(12);
      const result = await inspectPath(probe, file);
      expect(result.ok && result.image.ref.name).toBe("Shot 1.png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a FIFO is refused by the handle's kind, and the call returns (no hang)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "tentacle-attach-"));
    try {
      const fifo = join(dir, "pipe.png");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // The regression: a blocking open(2) on a fifo with no writer never returns.
      const info = await nodeFileProbe().read(fifo, 4096);
      expect(info).toEqual({ kind: "other", size: 0, bytes: new Uint8Array(0) });
      const result = await inspectPath(nodeFileProbe(), fifo);
      expect(result.ok === false && result.refusal.reason).toBe("not-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** `count` distinct PNG entries and their paths, from one seed letter. */
function imagePaths(
  seedLetter: string,
  count: number,
): {
  entries: Record<string, FakeEntry>;
  paths: string[];
} {
  const entries: Record<string, FakeEntry> = {};
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const path = `/${seedLetter}${i}.png`;
    entries[path] = { kind: "file", bytes: imageBytes(seedLetter.charCodeAt(0) * 100 + i) };
    paths.push(path);
  }
  return { entries, paths };
}
