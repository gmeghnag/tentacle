/**
 * The ONE scope→colour mapping (docs/feat/mobile-file-view.md part 1, decision
 * 7). It used to live inside `ui/CodeBlock.tsx`, untestable, and had no colour
 * for the scopes an `.html` file needs — so a page's tag names and attributes
 * all came out the same grey. These cases pin both halves: the chat block's
 * scopes keep their colours, and html's get one.
 */
import { describe, expect, test } from "bun:test";
import { scopeColor } from "../src/syntax-color.ts";
import type { Palette } from "../src/theme.ts";
import { darkPalette as dark, lightPalette as light } from "../src/theme.ts";

const THEMES = [dark, light];

describe("the chat block's scopes keep their colours", () => {
  test("keyword, comment, string, number and title", () => {
    expect(scopeColor("keyword", dark)).toBe(dark.kw);
    expect(scopeColor("comment", dark)).toBe(dark.com);
    expect(scopeColor("string", dark)).toBe(dark.green);
    expect(scopeColor("number", dark)).toBe(dark.orange);
    expect(scopeColor("title", dark)).toBe(dark.accent);
  });

  test("an unknown scope is the text colour, never a random one", () => {
    expect(scopeColor("subst", dark)).toBe(dark.label);
    expect(scopeColor("params", dark)).toBe(dark.label);
    expect(scopeColor("", dark)).toBe(dark.label);
  });
});

describe("html's scopes are distinguishable", () => {
  const scopes = [
    "tag",
    "name",
    "attr",
    "attribute",
    "selector-pseudo",
    "selector-class",
    "selector-id",
  ];

  test("every html scope is a real colour, not the fallback", () => {
    for (const scope of scopes) {
      expect(scopeColor(scope, dark)).not.toBe(dark.label);
    }
  });

  test("a tag NAME is not the same colour as its punctuation", () => {
    // `name` and `attr` must not collapse into `tag`, or `<style>` reads as one
    // grey smear — the property the owner asked for by name.
    expect(scopeColor("name", dark)).not.toBe(scopeColor("tag", dark));
    expect(scopeColor("attr", dark)).not.toBe(scopeColor("tag", dark));
  });

  test("both themes colour them (no light-only or dark-only token)", () => {
    for (const palette of THEMES) {
      for (const scope of scopes) {
        expect(scopeColor(scope, palette)).not.toBe(palette.label);
      }
    }
  });
});

describe("it is a pure function of scope + palette", () => {
  test("the two palettes really differ (the test above is not vacuous)", () => {
    const palette: Palette = dark;
    expect(palette.kw).not.toBe(light.kw);
  });
});
