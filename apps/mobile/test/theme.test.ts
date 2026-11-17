import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Palette,
  darkPalette,
  lightPalette,
  radius,
  shadow,
  size,
  space,
} from "../src/theme.ts";

/**
 * The readability gate for the phone's tokens (docs/feat/mobile-ui-polish.md
 * Design 1): every text colour the screens draw on every surface it is drawn on
 * clears WCAG 4.5:1, in both appearances. A hand-copied hex is the cheap thing to
 * get wrong, and a human cannot check it before every edit (the TUI's
 * `theme-contrast.test.ts` exists for the same reason).
 */

type Rgb = readonly [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const s = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    throw new Error(`not a #RRGGBB colour: ${hex}`);
  }
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

type Key = keyof Palette;

/** [text, surface] pairs that must read at 4.5:1. */
const TEXT_PAIRS: readonly (readonly [Key, Key])[] = [
  ...(["label", "sec", "accent"] as const).flatMap((text) =>
    (["bg", "card", "page", "fill", "sheet", "code", "band", "bandOnSheet", "drawer"] as const).map(
      (surface) => [text, surface] as const,
    ),
  ),
  ["accent", "tint"],
  ["label", "tint"],
  ["onAccent", "accentFill"],
  ["red", "fill"],
  ["red", "card"],
  ["green", "card"],
  ["green", "bg"],
  ["orange", "card"],
  ["warnText", "warnBg"],
  ["addText", "addBg"],
  ["delText", "delBg"],
  ["kw", "code"],
  ["com", "code"],
  ["label", "codeOnSheet"],
  // The E2 band surface (S1): a row's label and value sit on it, not on `card`.
  ["label", "band"],
  ["sec", "band"],
];

for (const [mode, palette] of [
  ["light", lightPalette],
  ["dark", darkPalette],
] as const) {
  describe(`theme contrast (${mode})`, () => {
    for (const [text, surface] of TEXT_PAIRS) {
      test(`${text} on ${surface} ≥ 4.5:1`, () => {
        const ratio = contrast(String(palette[text]), String(palette[surface]));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}

describe("theme tokens (aliases removed in Slice 6)", () => {
  test("no pre-restyle alias name is left on the palette", () => {
    const aliases = [
      "background",
      "groupedBackground",
      "secondaryLabel",
      "separator",
      "danger",
      "running",
      "badgeText",
    ];
    for (const palette of [lightPalette, darkPalette]) {
      expect(Object.keys(palette).filter((key) => aliases.includes(key))).toEqual([]);
    }
  });

  test("the code background differs from the bubble it sits in (B4 stays fixed)", () => {
    for (const palette of [lightPalette, darkPalette]) {
      expect(palette.code).not.toBe(palette.fill);
    }
  });
});

/**
 * S1 of docs/feat/mobile-chrome.md, retuned by docs/feat/mobile-dark-ardesia.md:
 * the dark ramp is now B3 "Ardesia neutra" (cool-neutral, sits next to the cyan
 * accent) instead of B1's warm graphite. The hexes are pinned so a later token
 * tweak cannot quietly undo the owner's choice (Owner Q-B, 17/11) or land on a
 * worse ground than the one F9 measured.
 */
describe("S1 · the dark ramp is B3 · Ardesia neutra (Owner, 17/11)", () => {
  const B3 = {
    bg: "#1E1F21",
    page: "#1E1F21",
    card: "#28292C",
    sheet: "#28292C",
    fill: "#313236",
    code: "#28292C",
    codeOnSheet: "#313236",
    label: "#EDEEF0",
    sec: "#A0A3A8",
    sep: "#37383C",
    sepChat: "#313236",
    sepSheet: "#3D3E42",
    glass: "rgba(40,41,44,0.86)",
    glassBorder: "rgba(255,255,255,0.07)",
    scrim: "rgba(0,0,0,0.45)",
    switchOff: "#434448",
    drawer: "#19191B",
  } as const satisfies Partial<Palette>;

  test("every B3 token is the approved value", () => {
    const got = Object.fromEntries(
      Object.keys(B3).map((k) => [k, darkPalette[k as keyof typeof B3]]),
    );
    expect(got).toEqual(B3);
  });

  test("the owner's six: page, card, fill, label, sec, sep", () => {
    // The exact hexes the owner gave on 17/11 (B3 · Ardesia neutra).
    expect(darkPalette.page).toBe("#1E1F21");
    expect(darkPalette.card).toBe("#28292C");
    expect(darkPalette.fill).toBe("#313236");
    expect(darkPalette.label).toBe("#EDEEF0");
    expect(darkPalette.sec).toBe("#A0A3A8");
    expect(darkPalette.sep).toBe("#37383C");
  });

  test("the dark page is cool slate, never pure black nor B1's warm graphite", () => {
    expect(darkPalette.page).not.toBe("#000000");
    expect(darkPalette.bg).toBe("#1E1F21");
    expect(darkPalette.page).not.toBe("#1F1F1E");
    // Cool-neutral: the blue channel is the largest one, unlike B1's warm ramp.
    const r = Number.parseInt(darkPalette.page.slice(1, 3), 16);
    const g = Number.parseInt(darkPalette.page.slice(3, 5), 16);
    const b = Number.parseInt(darkPalette.page.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(darkPalette.shadowOpacity).toBe(0.35);
  });

  test("the surfaces step up from the page in the approved order", () => {
    // A screen reads as layers only if page < card = sheet <= fill, in luminance.
    const page = luminance(hexToRgb(darkPalette.page));
    const card = luminance(hexToRgb(darkPalette.card));
    const fill = luminance(hexToRgb(darkPalette.fill));
    expect(card).toBeGreaterThan(page);
    expect(fill).toBeGreaterThanOrEqual(card);
    // The drawer sits one step BELOW the page, so the panel reads without a shadow.
    expect(luminance(hexToRgb(darkPalette.drawer))).toBeLessThan(page);
  });

  test("B3's ground left the semantic colours readable (the 4.4977 near-miss)", () => {
    // `#FF6961` on B1's `fill` measured 4.4977:1 — under F9's floor by 0.002, so
    // the dark `red` was lightened. Pinned here so it cannot drift back.
    expect(contrast(darkPalette.red, darkPalette.fill)).toBeGreaterThanOrEqual(4.5);
    expect(darkPalette.red).not.toBe("#FF6961");
  });
});

describe("S1 · `band` is one step above what it sits on (E2)", () => {
  test("dark: a band on the page, and a band on a sheet", () => {
    expect(darkPalette.band).toBe("#242528");
    expect(darkPalette.bandOnSheet).toBe("#28292C");
    // The sheet's own ground becomes the page, so the band still reads above it.
    expect(contrast(darkPalette.band, darkPalette.page)).toBeGreaterThan(1);
    expect(contrast(darkPalette.bandOnSheet, darkPalette.page)).toBeGreaterThan(1);
  });

  test("light: a white band on the grouped ground, on the page and in a sheet", () => {
    expect(lightPalette.band).toBe("#FFFFFF");
    expect(lightPalette.bandOnSheet).toBe("#FFFFFF");
    expect(lightPalette.band).not.toBe(lightPalette.bg);
    expect(lightPalette.drawer).toBe("#F7F7F8");
  });

  test("a band is never its own ground in either palette (it would be invisible)", () => {
    // A band's ground is the grouped screen's `bg`: dark #1E1F21, light #F2F2F7.
    // A BANDED SHEET's bg is that same ground — its ground is no longer `sheet`
    // — so both band tokens are measured against `bg`, not against `sheet`.
    for (const palette of [lightPalette, darkPalette]) {
      for (const band of [palette.band, palette.bandOnSheet]) {
        expect(band).not.toBe(palette.bg);
        expect(luminance(hexToRgb(band))).toBeGreaterThan(luminance(hexToRgb(palette.bg)));
      }
    }
  });

  test("the band's own text floors: label ≥ 4.5:1, sec ≥ 4.5:1", () => {
    for (const palette of [lightPalette, darkPalette]) {
      expect(contrast(palette.label, palette.band)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.sec, palette.band)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("S1 · E2 geometry (square bands, a thin sheet, a shorter header)", () => {
  test("`radius.card` is 0 (square bands) and `radius.sheet` is 14", () => {
    expect(radius.card).toBe(0);
    expect(radius.sheet).toBe(14);
  });

  test("`radius.dialog` keeps the alert-style dialog rounded (review round 1)", () => {
    // E2 squares the BAND surfaces; the rename dialog is not one — it is a
    // centred alert floating over a scrim (RenameSheet.tsx, maxWidth 340), and
    // iOS alerts keep a ~14 pt corner. Squaring it was an accident of it sharing
    // `radius.card` with GroupedCard, so it gets its own token.
    expect(radius.dialog).toBeGreaterThanOrEqual(14);
    expect(radius.dialog).toBeLessThanOrEqual(26);
  });

  test("`radius.card` is read only by the band primitives (it is 0 now)", () => {
    // Scanned from source: it is 0, so any other surface reaching for it is
    // silently sharpened — which is exactly how the rename dialog got squared
    // before review round 1. S4 replaces `GroupedCard` with `BandSection`; both
    // are band primitives, so the allowlist covers either.
    const users = readdirSync(join(import.meta.dir, "..", "src"), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) =>
        readFileSync(join(import.meta.dir, "..", "src", file), "utf8").includes("radius.card"),
      );
    for (const file of users) {
      expect(file).toMatch(/(GroupedCard|BandSection)\.tsx$/);
    }
    // Non-vacuity: the scan really does see a consumer today.
    expect(users.length).toBeGreaterThan(0);
  });

  test("the new spacing and row tokens exist", () => {
    expect(space.rowX).toBe(20);
    expect(space.sectionTop).toBe(22);
    expect(size.rowList).toBe(50);
  });

  test("the chat header is 50 pt, the list header untouched (A1)", () => {
    expect(size.headerChat).toBe(50);
    // `header-collapse.ts` derives a list screen's collapse offset from this one;
    // changing it would move that threshold, which S1 does not own.
    expect(size.headerList).toBe(52);
  });
});

describe("the dark palette can be reached on a device", () => {
  test("app.json lets iOS follow the system appearance (visual review 1, F2)", () => {
    // Without `userInterfaceStyle`, Expo writes `UIUserInterfaceStyle = Light`
    // into Info.plist, `useColorScheme()` then always answers `light`, and every
    // dark token above is unreachable: the dark simulator shots came out light.
    const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.json"), "utf8")) as {
      expo?: { userInterfaceStyle?: unknown };
    };
    expect(config.expo?.userInterfaceStyle).toBe("automatic");
  });
});

describe("the glass shadow (visual review N10)", () => {
  // CSS `0 6px 20px rgba(0,0,0,0.12)`: a 20 px CSS blur is a 10 pt iOS
  // shadowRadius. At 20 the light page showed a grey smudge round each button.
  test("one token: offset y 6, radius 10; light opacity 0.12", () => {
    expect(shadow.glass.shadowOffset).toEqual({ width: 0, height: 6 });
    expect(shadow.glass.shadowRadius).toBe(10);
    expect(lightPalette.shadowOpacity).toBe(0.12);
  });
  test("the glass button and the composer read the token, not their own radius", () => {
    for (const file of ["GlassButton.tsx", "Composer.tsx"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", "ui", file), "utf8");
      expect(src).toContain("shadow.glass");
      expect(src).not.toMatch(/shadowRadius:\s*20/);
    }
  });
});
