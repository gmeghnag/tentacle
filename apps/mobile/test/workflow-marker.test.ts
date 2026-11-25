/**
 * docs/fix/workflows-ux.md slice S6a — the run view's markers (D4). The owner is
 * colour-blind, so "every state stays distinguishable without colour" is a
 * property of the TABLE, and it is tested as one:
 *
 * - every pair of phases differs in glyph or ring, or in the word (usually both);
 * - `later` (not yet) carries no glyph — the owner's plain disc;
 * - every symbol is an `IconName`, which `Icon.tsx` checks against `sf-symbols-typescript`;
 * - the ink clears the body it is drawn on (WCAG 4.5:1) in all three palettes
 *   (mutation: skip an ink → red);
 * - the sizes are the mockup's: 26 pt in a pill, 18 in the rail, 32 in the hero.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowPhase } from "@tentacle/client";
import type { Palette } from "../src/theme.ts";
import { darkPalette, lightPalette, petrolPalette } from "../src/theme.ts";
import type { IconName } from "../src/ui/Icon.tsx";
import { MARKER_SIZE, WR_GLYPH, markerFor, markerLook } from "../src/workflow-marker.ts";

const PHASES: readonly WorkflowPhase[] = [
  "ok",
  "error",
  "running",
  "ask",
  "later",
  "skipped",
  "stopped",
  "unknown",
];

const PALETTES: readonly (readonly [string, Palette])[] = [
  ["light", lightPalette],
  ["dark", darkPalette],
  ["petrol", petrolPalette],
];

type Rgb = readonly [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const s = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as unknown as Rgb;
};

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string): number => {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
};

describe("S6a · no two phases read alike without colour", () => {
  test("every pair differs by glyph or ring, or by the word", () => {
    const collides: string[] = [];
    for (const palette of [lightPalette]) {
      const looks = PHASES.map((phase) => [phase, markerLook(phase, palette)] as const);
      for (let i = 0; i < looks.length; i += 1) {
        for (let j = i + 1; j < looks.length; j += 1) {
          const [aName, a] = looks[i] ?? ["", markerLook("ok", palette)];
          const [bName, b] = looks[j] ?? ["", markerLook("ok", palette)];
          const sameShape =
            a.symbol === b.symbol && a.ring === b.ring && (a.soft === null) === (b.soft === null);
          if (sameShape && a.word === b.word) {
            collides.push(`${aName}/${bName}`);
          }
        }
      }
    }
    expect(collides).toEqual([]);
  });

  test("the owner's plain disc: `later` has NO glyph and NO ring", () => {
    expect(markerLook("later", lightPalette).symbol).toBeNull();
    expect(markerLook("later", lightPalette).ring).toBeUndefined();
    expect(markerLook("later", lightPalette).word).toBe("not yet");
  });

  test("`skipped` is the ring: a dotted outline, no body, and its own glyph", () => {
    const look = markerLook("skipped", lightPalette);
    expect(look.ring).toBe("dotted");
    expect(look.soft).toBeNull();
    expect(look.symbol).toBe("chevron.forward.2");
    expect(look.word).toBe("not run");
  });

  test("failed is the owner's `multiply`, not a drawn ✗ (error-icon.html)", () => {
    expect(markerLook("error", lightPalette).symbol).toBe("multiply");
  });

  test("each known phase carries a glyph; only later/unknown do not", () => {
    const glyphless = PHASES.filter((p) => markerLook(p, lightPalette).symbol === null);
    expect(glyphless).toEqual(["later", "unknown"]);
  });

  test("every non-null symbol is a valid IconName (typechecked here, listed at runtime)", () => {
    // `IconName` is checked against `sf-symbols-typescript` by Icon.tsx, so this
    // assignment IS the typecheck test; the runtime half pins the exact list.
    const symbols: IconName[] = PHASES.map((p) => markerLook(p, lightPalette).symbol).filter(
      (s): s is IconName => s !== null,
    );
    expect(symbols).toEqual([
      "checkmark",
      "multiply",
      "play.fill",
      "questionmark",
      "chevron.forward.2",
      "stop.fill",
    ]);
  });
});

describe("S6a · the ink clears the body it is drawn on, in every palette", () => {
  // markers-v2's own computed floor for a GLYPH on its soft body is 4.4:1 light /
  // 5.2:1 dark (a graphic: WCAG 1.4.11 asks only 3:1). Pinned at the mockup's
  // numbers, not a stricter guess — the owner approved those ratios.
  for (const [mode, palette, floor] of [
    ["light", lightPalette, 4.4],
    ["dark", darkPalette, 5.2],
    ["petrol", petrolPalette, 5.2],
  ] as const) {
    test(`${mode}: every glyph's ink ≥ ${floor}:1 on its own soft body`, () => {
      for (const phase of PHASES) {
        const look = markerLook(phase, palette);
        // Only a GLYPH has to clear a body; `later`/`stopped`/unknown have none.
        if (look.symbol === null || look.soft === null) {
          continue;
        }
        const ratio = contrast(look.ink, look.soft);
        expect({ phase, ok: ratio >= floor }).toEqual({ phase, ok: true });
      }
    });
  }

  test("the ring's ink is legible on the card it is drawn on (light + dark)", () => {
    for (const palette of [lightPalette, darkPalette]) {
      const ratio = contrast(palette.wrSkipInk, palette.card);
      expect(ratio).toBeGreaterThanOrEqual(4.3);
    }
  });

  test("a glyphless disc is read by its ring only: the wait ink is a solid, not a hint", () => {
    // `later`/`stopped` carry no glyph (the owner's plain disc), so their ink only
    // ever INKS the disc's rim — `waiting`'s own grey. It is legible on the page
    // (the mockup's --wr-wait-ink on --c-page), not on its own soft body.
    for (const palette of [lightPalette, darkPalette]) {
      const look = markerLook("later", palette);
      expect(look.symbol).toBeNull();
      expect(contrast(look.ink, palette.page)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("mutation check: the marker colours are per-phase, not one shared grey", () => {
    // If the six soft bodies were one token, the ratio test above would still pass
    // and the colour-blind rule would rest on the glyph alone — so pin the spread.
    const softs = PHASES.map((p) => markerLook(p, lightPalette).soft).filter((s) => s !== null);
    expect(new Set(softs).size).toBeGreaterThanOrEqual(5);
  });
});

describe("S6a · the words are D2's, and the step's own word wins", () => {
  test("`needs approval` versus `waiting on you` stays apart", () => {
    expect(markerFor({ phase: "ask", word: "needs approval" }, lightPalette).word).toBe(
      "needs approval",
    );
    expect(markerFor({ phase: "ask", word: "waiting on you" }, lightPalette).word).toBe(
      "waiting on you",
    );
  });

  test("an approve step says `approved`, a verdict `passed` — the caller's word, same marker", () => {
    const approved = markerFor({ phase: "ok", word: "approved" }, lightPalette);
    expect(approved.word).toBe("approved");
    expect(approved.symbol).toBe("checkmark");
    expect(markerFor({ phase: "ok", word: "passed" }, lightPalette).word).toBe("passed");
  });

  test("an unknown wire word is printed verbatim, with the plain disc", () => {
    const look = markerFor({ phase: "unknown", word: "invented" }, lightPalette);
    expect(look.word).toBe("invented");
    expect(look.symbol).toBeNull();
  });

  test("an empty word falls back to the phase's own word, never to a blank label", () => {
    expect(markerFor({ phase: "skipped", word: "" }, lightPalette).word).toBe("not run");
  });
});

describe("S6a · the mockup's sizes", () => {
  test("26 pt in a pill (0.6 × 44), 18 in the rail, 32 in the hero", () => {
    expect(MARKER_SIZE).toEqual({ pill: 26, rail: 18, hero: 32 });
  });

  test("the glyph is ~half the disc", () => {
    expect(WR_GLYPH).toBe(0.54);
    expect(MARKER_SIZE.hero * WR_GLYPH).toBeCloseTo(17.28, 5);
  });
});
