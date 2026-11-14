/**
 * `photo-input` (docs/feat/mobile-compose.md D5, 13c): the type comes from the
 * BYTES, a HEIC is converted once, an over-cap photo is shrunk once, and a name
 * is sanitised by the wire's own rule.
 *
 * Each `describe` names the mutation it is red on (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES } from "@tentacle/core";
import { type PhotoState, nextPhotoStep, photoName } from "../src/photo-input.ts";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes: a real signature, then `pad` filler bytes to reach a size. */
function image(head: readonly number[], pad: number): Uint8Array {
  const bytes = new Uint8Array(head.length + pad);
  bytes.set(head, 0);
  for (let i = head.length; i < bytes.length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

const PNG = image(PNG_SIG, 16);
const JPEG = image([0xff, 0xd8, 0xff, 0xe0], 16);
const GIF = image(ascii("GIF89a"), 16);
const WEBP = image([...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBP")], 16);
/** ISO-BMFF: size, `ftyp`, then the brand. `mif1` is the HEIC still-image brand. */
const HEIC = image([0x00, 0x00, 0x00, 0x18, ...ascii("ftyp"), ...ascii("heic")], 16);

function state(overrides: Partial<PhotoState> = {}): PhotoState {
  return { bytes: PNG, taken: 0, converted: false, downscaled: false, ...overrides };
}

describe("nextPhotoStep — the type is the bytes', never the picker's", () => {
  test("PNG", () => {
    const step = nextPhotoStep(state({ name: "shot.png" }));
    expect(step).toEqual({
      kind: "ready",
      photo: { mimeType: "image/png", size: PNG.length, name: "shot.png" },
    });
  });

  test("JPEG / GIF / WebP sniff to their own types", () => {
    expect(nextPhotoStep(state({ bytes: JPEG }))).toMatchObject({
      photo: { mimeType: "image/jpeg" },
    });
    expect(nextPhotoStep(state({ bytes: GIF }))).toMatchObject({
      photo: { mimeType: "image/gif" },
    });
    expect(nextPhotoStep(state({ bytes: WEBP }))).toMatchObject({
      photo: { mimeType: "image/webp" },
    });
  });

  test("a HEIC named .jpg is NOT accepted as a JPEG (mutation: trust the picker's mime → green here → red)", () => {
    // The picker would report `image/jpeg` for this file, and its name says
    // `.jpg`. The BYTES say HEIC, so the answer must be "convert", not "ready".
    expect(nextPhotoStep(state({ bytes: HEIC, name: "IMG_0001.jpg" }))).toEqual({
      kind: "convert-to-jpeg",
    });
  });

  test("a JPEG that only CLAIMS .png goes out as image/jpeg, its name corrected (Step 0's finding)", () => {
    expect(nextPhotoStep(state({ bytes: JPEG, name: "screenshot.png" }))).toMatchObject({
      photo: { mimeType: "image/jpeg", name: "screenshot.jpg" },
    });
  });

  test("a video / a PDF / a truncated file is not-an-image", () => {
    expect(nextPhotoStep(state({ bytes: image(ascii("NOTANIMAGE!!"), 8) }))).toMatchObject({
      kind: "refuse",
      reason: "not-an-image",
    });
    // Two bytes cannot hold any signature: never a guess.
    expect(nextPhotoStep(state({ bytes: new Uint8Array([0xff, 0xd8]) }))).toMatchObject({
      kind: "refuse",
      reason: "not-an-image",
    });
  });
});

describe("nextPhotoStep — HEIC → JPEG, once (Owner Q3)", () => {
  test("the converted bytes are re-sniffed, and a JPEG result is ready", () => {
    // The adapter replaced the bytes with the JPEG it produced; the flag says
    // the one conversion is spent.
    expect(nextPhotoStep(state({ bytes: JPEG, converted: true, name: "IMG_0001.jpg" }))).toEqual({
      kind: "ready",
      photo: { mimeType: "image/jpeg", size: JPEG.length, name: "IMG_0001.jpg" },
    });
  });

  test("a conversion that is STILL HEIC is refused, never converted again (mutation: no `converted` check → an endless convert loop)", () => {
    expect(nextPhotoStep(state({ bytes: HEIC, converted: true }))).toMatchObject({
      kind: "refuse",
      reason: "not-an-image",
    });
  });
});

describe("nextPhotoStep — the 5-photo cap and the 15 MiB cap", () => {
  test(`${MAX_ATTACHMENTS_PER_MESSAGE} photos already taken → too-many`, () => {
    expect(nextPhotoStep(state({ taken: MAX_ATTACHMENTS_PER_MESSAGE }))).toMatchObject({
      kind: "refuse",
      reason: "too-many",
    });
  });

  test("one below the cap is still fine", () => {
    expect(nextPhotoStep(state({ taken: MAX_ATTACHMENTS_PER_MESSAGE - 1 }))).toMatchObject({
      kind: "ready",
    });
  });

  test("over MAX_IMAGE_BYTES → one downscale step, then ready (mutation: no downscale → too-large → red)", () => {
    const big = image(PNG_SIG, MAX_IMAGE_BYTES);
    expect(nextPhotoStep(state({ bytes: big }))).toEqual({ kind: "downscale" });
    // The adapter's smaller result, flagged as the one allowed shrink:
    const shrunk = image(PNG_SIG, 1024);
    expect(nextPhotoStep(state({ bytes: shrunk, downscaled: true }))).toMatchObject({
      kind: "ready",
      photo: { size: shrunk.length },
    });
  });

  test("still over the cap after the one shrink → refused too-large, with the size", () => {
    const big = image(PNG_SIG, MAX_IMAGE_BYTES);
    const step = nextPhotoStep(state({ bytes: big, downscaled: true }));
    expect(step).toMatchObject({ kind: "refuse", reason: "too-large" });
    if (step.kind === "refuse") {
      expect(step.detail).toContain("15 MB");
    }
  });

  test("a GIF over the cap is refused, never re-encoded (it would lose its animation)", () => {
    const bigGif = image(ascii("GIF89a"), MAX_IMAGE_BYTES);
    const step = nextPhotoStep(state({ bytes: bigGif }));
    expect(step).toMatchObject({ kind: "refuse", reason: "too-large" });
    if (step.kind === "refuse") {
      expect(step.detail).toContain("GIF");
    }
  });

  test("empty bytes → empty, before anything else", () => {
    expect(nextPhotoStep(state({ bytes: new Uint8Array(0) }))).toMatchObject({
      kind: "refuse",
      reason: "empty",
    });
  });

  test("too-many wins over a bad photo: the cap is checked first", () => {
    expect(
      nextPhotoStep(state({ bytes: new Uint8Array(0), taken: MAX_ATTACHMENTS_PER_MESSAGE })),
    ).toMatchObject({ reason: "too-many" });
  });
});

describe("the ref's name is sanitised by the wire's own rule", () => {
  test("a C1 CONTROLS character is removed (mutation: a \\u0000-\\u001f filter only → the C1 name survives → red)", () => {
    // `\u0085` (NEL) and `\u009b` (CSI) are the two that shipped a broken ref
    // once already: they pass a C0-only filter and throw at `checkAttachmentRefs`.
    expect(photoName("shot\u0085name\u009b.png")).toBe("shotname.png");
    // A C0 one is filtered too, of course.
    expect(photoName("a\u0000b\u001fc.png")).toBe("abc.png");
  });

  test("a name that is only control characters has no name at all", () => {
    expect(photoName("\u0085\u009b")).toBeUndefined();
  });

  test("a name past the wire's 255 cap is cut, and never splits a surrogate pair", () => {
    const long = photoName(`${"a".repeat(300)}.png`);
    expect(long?.length).toBe(255);
    const emoji = photoName(`${"a".repeat(254)}😀`);
    // A UTF-16 slice at 255 would leave a lone high surrogate behind.
    expect(emoji?.length).toBe(254);
  });

  test("no name stays no name", () => {
    expect(photoName(null)).toBeUndefined();
    expect(photoName(undefined)).toBeUndefined();
  });

  test("the READY photo carries the sanitised name, not the raw one", () => {
    const step = nextPhotoStep(state({ name: "IMG\u0085_0001.png" }));
    expect(step).toMatchObject({ photo: { name: "IMG_0001.png" } });
  });
});

describe("the ref's name never contradicts the type (found on the simulator)", () => {
  test("a HEIC converted to JPEG loses its .heic extension (mutation: return `name` unchanged → red)", () => {
    // Step 0's second probe: the shipped adapter sent a converted photo as
    // `{mimeType: "image/jpeg", name: "IMG_0111.heic"}`, so the transcript's own
    // `[image: IMG_0111.heic]` said the opposite of what was sent.
    expect(
      nextPhotoStep(state({ bytes: JPEG, converted: true, name: "IMG_0111.heic" })),
    ).toMatchObject({ photo: { mimeType: "image/jpeg", name: "IMG_0111.jpg" } });
  });

  test("a JPEG named .png is corrected too", () => {
    expect(nextPhotoStep(state({ bytes: JPEG, name: "shot.png" }))).toMatchObject({
      photo: { name: "shot.jpg" },
    });
  });

  test("a name that already agrees is untouched (jpg/jpeg are the same type)", () => {
    expect(nextPhotoStep(state({ bytes: JPEG, name: "a.JPG" }))).toMatchObject({
      photo: { name: "a.JPG" },
    });
    expect(nextPhotoStep(state({ bytes: JPEG, name: "a.jpeg" }))).toMatchObject({
      photo: { name: "a.jpeg" },
    });
    expect(nextPhotoStep(state({ bytes: PNG, name: "a.png" }))).toMatchObject({
      photo: { name: "a.png" },
    });
  });

  test("a name with no extension is left alone, never guessed at", () => {
    expect(nextPhotoStep(state({ bytes: PNG, name: "photo" }))).toMatchObject({
      photo: { name: "photo" },
    });
    // A dotfile-ish leading dot is not an extension either.
    expect(nextPhotoStep(state({ bytes: PNG, name: ".hidden" }))).toMatchObject({
      photo: { name: ".hidden" },
    });
  });

  test("a nameless photo stays nameless", () => {
    const step = nextPhotoStep(state({ bytes: JPEG, converted: true }));
    expect(step.kind === "ready" ? step.photo.name : "unexpected").toBeUndefined();
  });
});
