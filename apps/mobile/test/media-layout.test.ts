/**
 * `media-layout` S3/S4 of feat/mobile-thinking-images: `photoBlock` and
 * `userRowParts` (S3, mockup F), `viewerPages` (S4: which photos the full-screen
 * viewer holds and which page a tap opens) and `displayUri`.
 *
 * Each test names the mutation it is red on (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import {
  MEDIA_MAX_RATIO,
  displayUri,
  photoBlock,
  userRowParts,
  viewerPageAt,
  viewerPages,
} from "../src/media-layout.ts";

const ratio = (aspectRatio: number | undefined) =>
  aspectRatio === undefined ? {} : { aspectRatio };

/** One tile by index, asserted present first (never a `!` — AGENTS §9). */
function tileAt<T>(block: { readonly tiles: readonly T[] }, index: number): T {
  const tile = block.tiles[index];
  if (tile === undefined) {
    throw new Error(`no tile at ${index} (the block has ${block.tiles.length})`);
  }
  return tile;
}

describe("photoBlock — 1 photo keeps its own shape inside the cap", () => {
  test("a landscape photo is 200 × 150 at the cap (mutation: a fixed square → the photo is cropped for nothing)", () => {
    expect(photoBlock([ratio(4 / 3)])).toEqual({
      tiles: [{ ref: { aspectRatio: 4 / 3 }, box: { width: 200, height: 150, cropped: false } }],
      width: 200,
      height: 150,
    });
  });

  test("a portrait 3:4 photo is NOT cropped (mutation: clamp to the width → the normal iPhone photo loses a third)", () => {
    expect(tileAt(photoBlock([ratio(0.75)]), 0).box).toEqual({
      width: 200,
      height: 267,
      cropped: false,
    });
  });

  test("a panorama is capped at 200 wide and floored at 64 tall, cropped (mutation: no floor → a 6:1 photo is a 33 pt strip that shows nothing)", () => {
    expect(tileAt(photoBlock([ratio(6)]), 0).box).toEqual({
      width: 200,
      height: 64,
      cropped: true,
    });
  });

  test("a taller-than-clamp photo is clamped to 4/3 and cropped (the lone photo keeps the clamp)", () => {
    expect(tileAt(photoBlock([ratio(0.4)]), 0).box).toEqual({
      width: 200,
      height: 267,
      cropped: true,
    });
    expect(MEDIA_MAX_RATIO).toBeCloseTo(4 / 3);
  });

  test("a missing or nonsense ratio is a 200 square — the one shape an unknown image may take (mutation: divide by it → a 0-height tile)", () => {
    for (const bad of [undefined, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tileAt(photoBlock([ratio(bad)]), 0).box).toEqual({
        width: 200,
        height: 200,
        cropped: false,
      });
    }
  });

  test("a custom maxWidth is honoured, and the tile still fits in it (mutation: a hard 200 → an overflow in a narrower container)", () => {
    const block = photoBlock([ratio(1)], { maxWidth: 120 });
    expect(block.width).toBe(120);
    expect(tileAt(block, 0).box.width).toBeLessThanOrEqual(120);
  });
});

describe("photoBlock — 2 photos are squares side by side", () => {
  test("two equal tiles, a 4 pt gap, 200 pt of block (mutation: the old full-bubble stack → not the owner's side-by-side)", () => {
    const block = photoBlock([ratio(1), ratio(0.5)]);
    expect(block.tiles.map((tile) => tile.box)).toEqual([
      { width: 98, height: 98, cropped: false },
      { width: 98, height: 98, cropped: false },
    ]);
    expect(block.width).toBe(200);
    expect(block.height).toBe(98);
  });

  test("the photo's OWN ratio does not change a grid cell (the layout is the grid's, not the photo's)", () => {
    const tall = photoBlock([ratio(0.5), ratio(6)]);
    expect(tileAt(tall, 0).box).toEqual(tileAt(tall, 1).box);
  });
});

describe("photoBlock — 3 photos is a tall tile beside two stacked", () => {
  test("the first tile runs the whole height, the other two are squares (mutation: a plain 2 × 2 → an empty cell)", () => {
    const block = photoBlock([ratio(1), ratio(1), ratio(1)]);
    expect(block.tiles.map((tile) => tile.box)).toEqual([
      { width: 98, height: 200, cropped: false },
      { width: 98, height: 98, cropped: false },
      { width: 98, height: 98, cropped: false },
    ]);
    expect(block.width).toBe(200);
    expect(block.height).toBe(200);
  });
});

describe("photoBlock — 4 photos is a 2 × 2 grid", () => {
  test("four equal squares, no overflow (mutation: a tall first tile → the grid is lopsided)", () => {
    const block = photoBlock([ratio(1), ratio(1), ratio(1), ratio(1)]);
    expect(block.tiles.map((tile) => tile.box)).toEqual(
      Array.from({ length: 4 }, () => ({ width: 98, height: 98, cropped: false })),
    );
    expect(block.tiles.every((tile) => tile.overflow === undefined)).toBe(true);
    expect(block.width).toBe(200);
    expect(block.height).toBe(200);
  });

  test("the tiles are in reading order: 4 refs keep their own order", () => {
    const refs = ["a", "b", "c", "d"].map((id) => ({ id, ...ratio(1) }));
    expect(photoBlock(refs).tiles.map((tile) => tile.ref.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("photoBlock — more than 4 photos: the last tile carries +N", () => {
  test('5 photos draw 4 tiles and the last says +2 — itself and the hidden one (mutation: `refs.length - shown` → "+1", which is the tile itself)', () => {
    const block = photoBlock([ratio(1), ratio(1), ratio(1), ratio(1), ratio(1)]);
    expect(block.tiles).toHaveLength(4);
    expect(tileAt(block, 3).overflow).toBe(2);
    expect(block.tiles.slice(0, 3).every((tile) => tile.overflow === undefined)).toBe(true);
  });

  test("10 photos draw 4 tiles, the last says +7 (mutation: overflow counted from `maxTiles` → an off-by-one count)", () => {
    const block = photoBlock(Array.from({ length: 10 }, () => ratio(1)));
    expect(block.tiles).toHaveLength(4);
    expect(tileAt(block, 3).overflow).toBe(7);
  });

  test("a custom maxTiles hides the rest behind the last tile it draws", () => {
    const block = photoBlock([ratio(1), ratio(1), ratio(1), ratio(1)], { maxTiles: 2 });
    expect(block.tiles).toHaveLength(2);
    expect(tileAt(block, 1).overflow).toBe(3);
  });
});

describe("photoBlock — the empty and odd inputs", () => {
  test("no photos is an empty block, never a 0-size tile (mutation: a placeholder tile → an empty frame on every text row)", () => {
    expect(photoBlock([])).toEqual({ tiles: [], width: 0, height: 0 });
  });

  test("nothing 0-height, at any count or ratio (mutation: any floor removed → a box that renders as nothing)", () => {
    const counts = [1, 2, 3, 4, 5, 10];
    const ratios = [4 / 3, 0.75, 6, 0.4, undefined, 0];
    for (const count of counts) {
      for (const r of ratios) {
        const block = photoBlock(Array.from({ length: count }, () => ratio(r)));
        expect(block.height).toBeGreaterThan(0);
        expect(block.width).toBeGreaterThan(0);
        for (const tile of block.tiles) {
          expect(tile.box.width).toBeGreaterThan(0);
          expect(tile.box.height).toBeGreaterThan(0);
        }
      }
    }
  });

  test("no tile is wider than the cap, at any count (the owner's 200 pt limit)", () => {
    for (const count of [1, 2, 3, 4, 10]) {
      expect(photoBlock(Array.from({ length: count }, () => ratio(1))).width).toBeLessThanOrEqual(
        200,
      );
    }
  });
});

describe("userRowParts — a photo-only message has no bubble", () => {
  const user = (over: Partial<Parameters<typeof userRowParts>[0]>) => ({
    text: "",
    images: [],
    ...over,
  });
  const photo = { id: "a", mimeType: "image/png", size: 1 };

  test("photo-only: photos, no bubble (mutation: always a bubble → an empty fill block under the photo)", () => {
    expect(userRowParts(user({ images: [photo] }))).toEqual({ photos: true, bubble: false });
  });

  test("text-only: a bubble, no photos", () => {
    expect(userRowParts(user({ text: "ciao" }))).toEqual({ photos: false, bubble: true });
  });

  test("both: a photo block above a bubble that holds the caption", () => {
    expect(userRowParts(user({ text: "ciao", images: [photo] }))).toEqual({
      photos: true,
      bubble: true,
    });
  });

  test("a document line alone keeps the bubble (the files are named inside it)", () => {
    expect(userRowParts(user({ documents: ["report.pdf · 3 pp"] }))).toEqual({
      photos: false,
      bubble: true,
    });
  });

  test("a restart caption alone keeps the bubble (it is drawn inside it)", () => {
    expect(userRowParts(user({ restart: true }))).toEqual({ photos: false, bubble: true });
  });

  test("an entirely empty message draws nothing at all", () => {
    expect(userRowParts(user({}))).toEqual({ photos: false, bubble: false });
  });
});

describe("displayUri — a file that is gone falls back to the label (Review round 2, R2-1)", () => {
  test("an untried URI is drawn (mutation: always undefined → no photo is ever shown)", () => {
    expect(displayUri("file:///o/photos/a.png", [])).toBe("file:///o/photos/a.png");
  });

  test("a URI the Image reported as broken is NOT drawn, so the row draws its label instead of an empty frame (mutation: ignore `broken` → the empty bubble, and a tap opens an empty viewer)", () => {
    expect(displayUri("file:///o/photos/a.png", ["file:///o/photos/a.png"])).toBeUndefined();
    // One broken file does not condemn the others on the same row.
    expect(displayUri("file:///o/photos/b.png", ["file:///o/photos/a.png"])).toBe(
      "file:///o/photos/b.png",
    );
  });

  test("no candidate at all is still no candidate (a history row, another device's message)", () => {
    expect(displayUri(undefined, [])).toBeUndefined();
    expect(displayUri(undefined, ["file:///o/photos/a.png"])).toBeUndefined();
  });
});

describe("viewerPages — which photos the full screen holds, and which page a tap opens (S4)", () => {
  const tile = (uri: string | undefined, label = "photo") => ({ uri, label });

  test("every photo with pixels is a page, and the tapped one is its index (mutation: open the tile's position → a skipped tile shifts every count)", () => {
    const pages = viewerPages([tile("a"), tile("b"), tile("c")], 1);
    expect(pages.pages.map((page) => page.uri)).toEqual(["a", "b", "c"]);
    expect(pages.index).toBe(1);
    expect(pages.pages[1]?.label).toBe("photo");
  });

  test("a tile with no pixels is SKIPPED, not opened as an empty page (mutation: keep it → the viewer pages onto a blank screen)", () => {
    // b has no bytes (a history row, another device's message): 2 of 3, not 2 of 4.
    const pages = viewerPages([tile("a"), tile(undefined), tile("c")], 2);
    expect(pages.pages.map((page) => page.uri)).toEqual(["a", "c"]);
    // The tapped tile's page in the FILTERED list: the second page, not the third.
    expect(pages.index).toBe(1);
  });

  test("tapping a tile that has no pixels opens nothing at all (mutation: index 0 → the viewer opens the wrong photo)", () => {
    expect(viewerPages([tile(undefined), tile("b")], 0).index).toBe(-1);
    expect(viewerPages([tile(undefined), tile("b")], 0).pages).toHaveLength(1);
  });

  test("no photos, or a tap out of range: an empty viewer (-1 = closed)", () => {
    expect(viewerPages([], 0)).toEqual({ pages: [], index: -1 });
    expect(viewerPages([tile("a")], 3).index).toBe(-1);
  });

  test("the count the header reads is the photos with pixels, never the row's own list", () => {
    const pages = viewerPages([tile(undefined), tile(undefined), tile("c")], 2);
    expect(pages.pages).toHaveLength(1);
    expect(pages.index).toBe(0);
  });
});

describe("viewerPageAt: the page a swipe rests on (S4: the count and Share follow it)", () => {
  test("the nearest whole page to the offset (mutation: floor → a half-swiped page reads as the one before)", () => {
    expect(viewerPageAt(0, 390, 5)).toBe(0);
    expect(viewerPageAt(390, 390, 5)).toBe(1);
    expect(viewerPageAt(390 * 1.6, 390, 5)).toBe(2);
    expect(viewerPageAt(390 * 1.4, 390, 5)).toBe(1);
  });

  test("an iOS bounce past either end stays on a real page (mutation: no clamp → '6 of 5', '0 of 5')", () => {
    expect(viewerPageAt(-80, 390, 5)).toBe(0);
    expect(viewerPageAt(390 * 4 + 120, 390, 5)).toBe(4);
  });

  test("no pages → -1; an unknown width or a nonsense offset → the first page, never NaN", () => {
    expect(viewerPageAt(0, 390, 0)).toBe(-1);
    expect(viewerPageAt(390, 0, 3)).toBe(0);
    expect(viewerPageAt(Number.NaN, 390, 3)).toBe(0);
  });
});
