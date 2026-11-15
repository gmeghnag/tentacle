import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Palette, darkPalette, lightPalette, shadow } from "../src/theme.ts";

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
    (["bg", "card", "page", "fill", "sheet", "code"] as const).map(
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
