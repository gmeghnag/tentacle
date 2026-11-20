/**
 * The Lato bundle (docs/feat/mobile-theme-beta.md, Review round 1 finding 1):
 * the switch promises Lato, so the four faces, their licence and the root
 * NOTICE attribution must all actually ship. They were left out of the commit
 * once — the tree looked right and `main` would have bundled an OFL font with
 * no NOTICE line — and nothing failed.
 *
 * No React, no React Native: files only (`text-seam.test.ts`'s shape).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LATO_FACES } from "../src/theme-beta.ts";

const APP = join(import.meta.dir, "..");
const ROOT = join(APP, "..", "..");
const FONTS = join(APP, "assets", "fonts");

/** A TrueType file starts with 0x00010000 (`\0\1\0\0`), then the table count. */
const TRUETYPE_MAGIC = [0x00, 0x01, 0x00, 0x00];

/** The first bytes of a file, as plain numbers. */
const head = (path: string): number[] => [...readFileSync(path).subarray(0, 4)];

describe("the four Lato faces ship as real TrueType files", () => {
  for (const face of Object.values(LATO_FACES)) {
    test(`${face}.ttf is a readable TrueType font`, () => {
      const path = join(FONTS, `${face}.ttf`);
      expect(existsSync(path)).toBe(true);
      expect(head(path)).toEqual(TRUETYPE_MAGIC);
    });
  }

  test("the loader requires exactly those faces (no face asked for that is not bundled)", () => {
    const source = readFileSync(join(APP, "src", "fonts-expo.ts"), "utf8");
    const required = [...source.matchAll(/assets\/fonts\/([\w-]+)\.ttf/g)].map((m) => m[1]);
    expect(required.sort()).toEqual(Object.values(LATO_FACES).sort());
  });
});

describe("the licence and the attribution ship with them", () => {
  test("OFL.txt is the SIL Open Font License, not a placeholder", () => {
    const text = readFileSync(join(FONTS, "OFL.txt"), "utf8");
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text).toContain("Reserved Font Name");
  });

  test("the root NOTICE credits Lato and points at that licence file", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    expect(notice).toContain("Lato");
    expect(notice).toContain("SIL Open Font License");
    expect(notice).toContain("apps/mobile/assets/fonts/OFL.txt");
  });
});
