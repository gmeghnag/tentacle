/**
 * `media-layout` (fix/mobile-media-live item 4): the owner's WhatsApp-shaped
 * bubble — image on top at full bubble width, caption BELOW it, no empty text
 * area when there are no words.
 *
 * Each test names the mutation it is red on (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { MEDIA_MAX_RATIO, layoutMedia, mediaBox } from "../src/media-layout.ts";

describe("mediaBox — the image's shape follows the photo, bounded", () => {
  test("a landscape photo keeps its ratio at the full width", () => {
    // 4032×3024 → 4:3. At 300pt the box is 300×225.
    expect(mediaBox({ aspectRatio: 4 / 3 }, 300)).toEqual({
      width: 300,
      height: 225,
      cropped: false,
    });
  });

  test("a portrait photo is NOT cropped to square (mutation: clamp to `width` → a 3:4 photo loses a third of itself)", () => {
    // 3024×4032 → 0.75. 300 / 0.75 = 400, and 400 > 300 × 4/3 = 400? No: 400 is
    // exactly the clamp, so it fits exactly — the common iPhone portrait is the
    // case the clamp is sized for.
    expect(mediaBox({ aspectRatio: 0.75 }, 300)).toEqual({
      width: 300,
      height: 400,
      cropped: false,
    });
  });

  test("a taller-than-clamp photo IS clamped, and says it is cropped (never stretched)", () => {
    // 1:2 at 300pt wants 600pt; the clamp is 400pt.
    expect(mediaBox({ aspectRatio: 0.5 }, 300)).toEqual({
      width: 300,
      height: 400,
      cropped: true,
    });
  });

  test("a missing ratio is a square tile — the one shape an unknown image may take", () => {
    expect(mediaBox({}, 300)).toEqual({ width: 300, height: 300, cropped: false });
  });

  test("a nonsense ratio is treated as missing, never a zero-height box (mutation: divide by any number → height 0 → the image vanishes)", () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mediaBox({ aspectRatio: bad }, 300)).toEqual({
        width: 300,
        height: 300,
        cropped: false,
      });
    }
  });

  test("a zero width still gives a drawable box (a layout pass before the measurement)", () => {
    expect(mediaBox({ aspectRatio: 1 }, 0).width).toBe(1);
  });

  test("MEDIA_MAX_RATIO is the 4/3 the portrait case needs", () => {
    expect(MEDIA_MAX_RATIO).toBeCloseTo(4 / 3);
  });
});

describe("layoutMedia — media first, caption below, nothing empty", () => {
  test("with text, the caption goes BELOW the media (mutation: caption above → the text-then-squeezed-image layout the owner rejected)", () => {
    const layout = layoutMedia([{ aspectRatio: 4 / 3 }, { aspectRatio: 1 }], {
      width: 200,
      hasText: true,
    });
    expect(layout.captionBelow).toBe(true);
    expect(layout.boxes).toHaveLength(2);
  });

  test("with no text, there is no caption slot at all (mutation: always `true` → an empty block under the photo)", () => {
    expect(layoutMedia([{ aspectRatio: 1 }], { width: 200, hasText: false }).captionBelow).toBe(
      false,
    );
  });

  test("a text-only message has no media boxes and keeps its caption", () => {
    expect(layoutMedia([], { width: 200, hasText: true })).toEqual({
      boxes: [],
      captionBelow: true,
    });
  });
});
