/**
 * The "Button opacity" band's look (docs/fix/mobile-qa-1117.md, bug 1): the
 * slider's thumb must be SEEN in both schemes, and the preview's sample text is
 * ordinary chat copy, not a developer's note.
 *
 * QA shots 01/02: the thumb was `palette.page` — white on the white light band
 * (only a gap in the rail showed), #1E1F21 on #242528 in dark — and its
 * `shadow.glass` carried no `shadowOpacity`, so iOS drew no shadow at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_SAMPLE } from "../src/hub-opacity.ts";
import { darkPalette, lightPalette } from "../src/theme.ts";

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = ([r, g, b]: [number, number, number]): number => {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const contrast = (a: string, b: string): number => {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
};

const BAND = readFileSync(join(import.meta.dir, "..", "src", "ui", "HubOpacityBand.tsx"), "utf8");

/** The style object the thumb's `<View>` gets (the second entry of its style array). */
function thumbStyle(): string {
  const at = BAND.indexOf("styles.thumb,");
  if (at < 0) throw new Error("no thumb in HubOpacityBand.tsx");
  return BAND.slice(at, BAND.indexOf("]}", at));
}

describe("the slider thumb is visible", () => {
  test("its colour is the accent fill, not the page the band sits on", () => {
    expect(thumbStyle()).toContain("backgroundColor: palette.accentFill");
    expect(thumbStyle()).not.toContain("palette.page");
  });

  test("the accent fill reads against the band at the 3:1 non-text floor, both schemes", () => {
    for (const p of [lightPalette, darkPalette]) {
      expect(contrast(p.accentFill, p.band)).toBeGreaterThanOrEqual(3);
    }
  });

  test("its shadow has an opacity (iOS draws none without one)", () => {
    expect(thumbStyle()).toContain("shadowOpacity: palette.shadowOpacity");
  });
});

describe("the preview's sample text", () => {
  test("is the shared constant, rendered as is", () => {
    expect(BAND).toContain("{PREVIEW_SAMPLE}");
  });

  test("reads as a chat reply, with no test-suite jargon", () => {
    expect(PREVIEW_SAMPLE.length).toBeGreaterThan(40);
    expect(PREVIEW_SAMPLE).not.toMatch(/\b(tests?|suite|relay|ping|parallel)\b/i);
  });
});
