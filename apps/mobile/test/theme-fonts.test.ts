/**
 * The Figtree bundle (docs/feat/mobile-theme-beta.md, Review round 1 finding 1;
 * Owner decision 2026-11-21): the switch promises Figtree, so the faces, their
 * licence and the root NOTICE attribution must all actually ship. They were left
 * out of the commit once — the tree looked right and `main` would have bundled an
 * OFL font with no NOTICE line — and nothing failed. The Lato faces it replaced
 * must be gone (no dead font in the app bundle).
 *
 * docs/fix/mobile-transcript-type.md added the 500/600 faces AND the walk that
 * keeps them honest: every weight the app asks (a token, transcript prose, a bold
 * run) must be the weight class of the very face it resolves to.
 *
 * No React, no React Native: files only (`text-seam.test.ts`'s shape).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIGTREE_FACES, figtreeFace } from "../src/theme-beta.ts";
import { darkPalette, lightPalette, typography } from "../src/theme.ts";
import { proseFontWeight } from "../src/transcript-type.ts";

const APP = join(import.meta.dir, "..");
const ROOT = join(APP, "..", "..");
const FONTS = join(APP, "assets", "fonts");

/** A TrueType file starts with 0x00010000 (`\0\1\0\0`), then the table count. */
const TRUETYPE_MAGIC = [0x00, 0x01, 0x00, 0x00];

/** The first bytes of a file, as plain numbers. */
const head = (path: string): number[] => [...readFileSync(path).subarray(0, 4)];

describe("the eight Figtree faces ship as real TrueType files", () => {
  for (const face of Object.values(FIGTREE_FACES)) {
    test(`${face}.ttf is a readable TrueType font`, () => {
      const path = join(FONTS, `${face}.ttf`);
      expect(existsSync(path)).toBe(true);
      expect(head(path)).toEqual(TRUETYPE_MAGIC);
    });
  }

  test("the loader requires exactly those faces (no face asked for that is not bundled)", () => {
    const source = readFileSync(join(APP, "src", "fonts-expo.ts"), "utf8");
    const required = [...source.matchAll(/assets\/fonts\/([\w-]+)\.ttf/g)].map((m) => m[1]);
    expect(required.sort()).toEqual(Object.values(FIGTREE_FACES).sort());
  });

  test("the fonts folder bundles those faces and no other font", () => {
    const fonts = readdirSync(FONTS).filter((f) => /\.(ttf|otf)$/i.test(f));
    expect(fonts.sort()).toEqual(
      Object.values(FIGTREE_FACES)
        .map((f) => `${f}.ttf`)
        .sort(),
    );
  });
});

/**
 * docs/fix/mobile-transcript-type.md (owner decision 1): a `fontWeight` no bundled
 * face carries is a NO-OP — `figtreeFace` rounds it to the nearest face it has, so
 * the step title asked 500 and iOS drew 400. Every token's weight must therefore be
 * the weight class of the very face it resolves to, and that face's file must ship.
 */
describe("every typography token's weight is the bundled face's own weight", () => {
  /** A TrueType's `usWeightClass`, from its `OS/2` table (offset 4 of the table). */
  function weightClass(path: string): number {
    const font = readFileSync(path);
    const tables = font.readUInt16BE(4);
    for (let i = 0; i < tables; i += 1) {
      const entry = 12 + i * 16;
      if (font.toString("latin1", entry, entry + 4) !== "OS/2") continue;
      return font.readUInt16BE(font.readUInt32BE(entry + 8) + 4);
    }
    throw new Error(`${path} has no OS/2 table`);
  }

  const weighed = Object.entries(typography).filter(
    ([, token]) => (token as { fontWeight?: string }).fontWeight !== undefined,
  );

  test("the tokens do ask weights (an empty walk would pass vacuously)", () => {
    expect(weighed.length).toBeGreaterThanOrEqual(8);
  });

  for (const [name, token] of weighed) {
    const asked = String((token as { fontWeight?: string }).fontWeight);
    test(`${name}: ${asked} resolves to a face that IS ${asked}`, () => {
      const face = figtreeFace(asked, undefined);
      const path = join(FONTS, `${face}.ttf`);
      expect(existsSync(path)).toBe(true);
      expect(weightClass(path)).toBe(Number(asked));
    });
  }

  /**
   * The weights that are NOT in the token table but are still asked at render time:
   * transcript prose's (`transcript-type.ts` — 500 on a dark ground, 400 on light)
   * and the markdown's bold run. A token walk alone missed exactly these: with 500
   * removed from `figtreeFace`, prose still asked 500 and no test noticed.
   */
  const PROSE_WEIGHTS = [proseFontWeight(darkPalette), proseFontWeight(lightPalette)];
  for (const asked of PROSE_WEIGHTS) {
    test(`transcript prose: ${asked} resolves to a face that IS ${asked}`, () => {
      const face = figtreeFace(asked, undefined);
      const path = join(FONTS, `${face}.ttf`);
      expect(existsSync(path)).toBe(true);
      expect(weightClass(path)).toBe(Number(asked));
      // Italic too: an `em` span inside prose keeps its weight and gains the slant.
      const italic = figtreeFace(asked, "italic");
      const italicPath = join(FONTS, `${italic}.ttf`);
      expect(existsSync(italicPath)).toBe(true);
      expect(weightClass(italicPath)).toBe(Number(asked));
    });
  }

  test("the markdown's bold run resolves to a face that IS 700", () => {
    const bold = /bold: \{ fontWeight: "(\d{3})" \}/.exec(
      readFileSync(join(APP, "src", "screens", "transcript", "Markdown.tsx"), "utf8"),
    );
    expect(bold?.[1]).toBeDefined();
    const ask = bold?.[1] ?? "";
    const face = figtreeFace(ask, undefined);
    expect(existsSync(join(FONTS, `${face}.ttf`))).toBe(true);
    expect(weightClass(join(FONTS, `${face}.ttf`))).toBe(Number(ask));
  });
});

describe("the licence and the attribution ship with them", () => {
  test("OFL.txt is Figtree's SIL Open Font License, not a placeholder", () => {
    const text = readFileSync(join(FONTS, "OFL.txt"), "utf8");
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text).toContain("The Figtree Project Authors");
    expect(text).not.toContain("Lato");
  });

  test("the root NOTICE credits Figtree (not Lato) and points at that licence file", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    expect(notice).toContain("Figtree");
    expect(notice).not.toContain("Lato");
    expect(notice).toContain("SIL Open Font License");
    expect(notice).toContain("apps/mobile/assets/fonts/OFL.txt");
  });
});
