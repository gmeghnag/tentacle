import { describe } from "bun:test";
import { expect, test } from "bun:test";
import { Chalk } from "chalk";
import { tokens } from "../src/theme.ts";

/**
 * The readability gate (docs/feat/tui-light-theme.md S3).
 *
 * The light palette's whole point is that it stays legible on a light terminal —
 * which a human cannot check before every edit, and which a hand-computed table
 * gets wrong (the plan's first table did, three times: it modelled chalk's 256
 * downgrade as rounding when it is `rgbToAnsi256`, ramp-only for exact greys).
 *
 * So the ratios are COMPUTED here, in two colour depths:
 *   - truecolor, against white (#ffffff) and against Solarized Light (#fdf6e3),
 *     the brightest and the warmest "paper" a user is likely to have;
 *   - 256 colours, by ASKING CHALK what it will actually paint at level 2 —
 *     not by re-deriving its palette — because that is the code path that runs.
 *
 * Bars: 4.5:1 for text, 3:1 for non-text (borders). ONE token cannot meet 4.5
 * at 256 and is a NAMED exception, an owner decision: `accent` (Q3: no cyan-like
 * bucket reaches 4.5; navy would lose the brand). `notice` was a second one for
 * a round; the owner's fix-round answer moved it to `#2f4ba8` (5.61 at 256), so
 * the gate is the owner's "all but the accent" again. Anything else must clear
 * the bar, so a future edit cannot quietly make a token unreadable.
 */

type Rgb = readonly [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const s = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
};

/** WCAG relative luminance. */
const luminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: Rgb, b: Rgb): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
};

/** The xterm-256 palette, indexed by the code SGR carries. */
const XTERM: readonly Rgb[] = (() => {
  const base: Rgb[] = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [192, 192, 192],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ];
  const cube = [0, 95, 135, 175, 215, 255];
  const out = [...base];
  for (const r of cube) {
    for (const g of cube) {
      for (const b of cube) {
        out.push([r, g, b]);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push([v, v, v]);
  }
  return out;
})();

const ansi256 = new Chalk({ level: 2 });
const ansi16 = new Chalk({ level: 1 });

/** What chalk paints for this token at 256 colours (fg and bg respectively). */
const painted256 = (hex: string, background = false): Rgb => {
  const sgr = (background ? ansi256.bgHex(hex) : ansi256.hex(hex))("X");
  const match = /(?:38|48);5;(\d+)/.exec(sgr);
  if (!match) {
    throw new Error(`chalk did not downgrade ${hex} to 256: ${JSON.stringify(sgr)}`);
  }
  const entry = XTERM[Number(match[1])];
  if (!entry) {
    throw new Error(`no xterm entry ${match[1]} for ${hex}`);
  }
  return entry;
};

const WHITE = hexToRgb("#ffffff");
const SOLARIZED_LIGHT = hexToRgb("#fdf6e3");

/** The named 256-colour exception, with the reason it is allowed. */
const EXCEPT_256: Readonly<Record<string, string>> = {
  accent: "Q3: no cyan-like 256 bucket reaches 4.5; navy would lose the brand",
};

/** One text token and the background it is painted on. */
interface Row {
  readonly name: string;
  readonly value: string;
  /** Absent = the terminal's own background (white / Solarized in the two checks). */
  readonly on?: string;
  /** The border bar is 3:1 (WCAG non-text). */
  readonly min?: number;
}

const TEXT_ROWS: readonly Row[] = [
  { name: "accent", value: tokens.light.accent },
  { name: "autoAccept", value: tokens.light.autoAccept },
  { name: "subtle", value: tokens.light.subtle },
  { name: "dim", value: tokens.light.dim },
  { name: "gutter", value: tokens.light.gutter },
  { name: "notice", value: tokens.light.notice },
  { name: "success", value: tokens.light.success },
  { name: "error", value: tokens.light.error },
  { name: "warn", value: tokens.light.warn },
  { name: "quit", value: tokens.light.quit },
  { name: "status.linkError", value: tokens.light.status.linkError },
  { name: "status.linkWarn", value: tokens.light.status.linkWarn },
  { name: "status.scrolled", value: tokens.light.status.scrolled },
  { name: "meter.low", value: tokens.light.meter.low },
  { name: "meter.mid", value: tokens.light.meter.mid },
  { name: "meter.high", value: tokens.light.meter.high },
  { name: "syntax.keyword", value: tokens.light.syntax.keyword },
  { name: "syntax.string", value: tokens.light.syntax.string },
  { name: "syntax.number", value: tokens.light.syntax.number },
  { name: "syntax.comment", value: tokens.light.syntax.comment },
  { name: "syntax.title", value: tokens.light.syntax.title },
  { name: "syntax.type", value: tokens.light.syntax.type },
  { name: "syntax.meta", value: tokens.light.syntax.meta },
  { name: "syntax.tag", value: tokens.light.syntax.tag },
  { name: "md.code", value: tokens.light.md.code },
  { name: "md.firstHeading", value: tokens.light.md.firstHeading },
  { name: "md.heading", value: tokens.light.md.heading },
  { name: "md.quote", value: tokens.light.md.quote },
  { name: "md.del", value: tokens.light.md.del },
  { name: "md.link", value: tokens.light.md.link },
  // Text on a tint: the ratio is against THAT tint, not the terminal.
  { name: "diff.addFg", value: tokens.light.diff.addFg, on: tokens.light.diff.addBg },
  { name: "diff.addGutter", value: tokens.light.diff.addGutter, on: tokens.light.diff.addBg },
  { name: "diff.addWordFg", value: tokens.light.diff.addWordFg, on: tokens.light.diff.addWordBg },
  { name: "diff.delFg", value: tokens.light.diff.delFg, on: tokens.light.diff.delBg },
  { name: "diff.delGutter", value: tokens.light.diff.delGutter, on: tokens.light.diff.delBg },
  { name: "diff.delWordFg", value: tokens.light.diff.delWordFg, on: tokens.light.diff.delWordBg },
  { name: "message.queuedFg", value: tokens.light.message.queuedFg, on: tokens.light.message.bg },
  { name: "message.accent", value: tokens.light.accent, on: tokens.light.message.bg },
];

const NON_TEXT_ROWS: readonly Row[] = [
  { name: "border", value: tokens.light.border, min: 3 },
  { name: "diff.border", value: tokens.light.diff.border, min: 3 },
  { name: "quitBorder", value: tokens.light.quit, min: 3 },
];

describe("the light palette is readable", () => {
  test("truecolor: every text token clears 4.5:1 on white and on Solarized Light", () => {
    const failures: string[] = [];
    for (const row of TEXT_ROWS) {
      const min = row.min ?? 4.5;
      const backgrounds = row.on === undefined ? [WHITE, SOLARIZED_LIGHT] : [hexToRgb(row.on)];
      for (const bg of backgrounds) {
        const ratio = contrast(hexToRgb(row.value), bg);
        if (ratio < min) {
          failures.push(
            `${row.name} ${row.value} on ${row.on ?? "the terminal"}: ${ratio.toFixed(2)} < ${min}`,
          );
        }
      }
    }
    // Mutation: any light token darkened toward #b45309/#8c8c8f → one line here.
    expect(failures).toEqual([]);
  });

  test("256 colours: every text token clear 4.5:1 as chalk actually paints it", () => {
    const failures: string[] = [];
    for (const row of TEXT_ROWS) {
      if (EXCEPT_256[row.name === "message.accent" ? "accent" : row.name] !== undefined) {
        continue;
      }
      const min = row.min ?? 4.5;
      const fg = painted256(row.value);
      const backgrounds =
        row.on === undefined
          ? [painted256("#ffffff"), painted256("#fdf6e3")]
          : [painted256(row.on, true)];
      for (const bg of backgrounds) {
        const ratio = contrast(fg, bg);
        if (ratio < min) {
          failures.push(`${row.name} ${row.value} at 256: ${ratio.toFixed(2)} < ${min}`);
        }
      }
    }
    // Mutation: `subtle` back to #6b6b6f (cube, not ramp) → 3.59 here.
    expect(failures).toEqual([]);
  });

  test("the named 256 exception is only the accent", () => {
    // A second exception silently weakens an owner gate; this pins the list.
    // Mutation: re-add `notice` (e.g. back to #3b5bdb at 3.54) → one element here.
    expect(Object.keys(EXCEPT_256).sort()).toEqual(["accent"]);
  });

  test("non-text colours clear 3:1", () => {
    for (const row of NON_TEXT_ROWS) {
      const ratio = contrast(hexToRgb(row.value), WHITE);
      expect({ name: row.name, ok: ratio >= 3 }).toEqual({ name: row.name, ok: true });
    }
  });

  test("the dark palette still clears its own bar on a dark terminal", () => {
    // Dark is not re-tuned, but it must not be WORSE than the old palette either:
    // the old values are all >= 3:1 on #1e1e1e, and named colours are the user's.
    const NAMED = new Set(["dim", "gray", "red", "yellow", "green", "blue", "magenta", "hidden"]);
    const darkBg = hexToRgb("#1e1e1e");
    const failures: string[] = [];
    for (const [name, value] of Object.entries({
      accent: tokens.dark.accent,
      autoAccept: tokens.dark.autoAccept,
      subtle: tokens.dark.subtle,
      notice: tokens.dark.notice,
      success: tokens.dark.success,
      error: tokens.dark.error,
      warn: tokens.dark.warn,
    })) {
      if (NAMED.has(value)) {
        continue;
      }
      const ratio = contrast(hexToRgb(value), darkBg);
      if (ratio < 3) {
        failures.push(`${name} ${value}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// Keep the 16-colour path honest: `ansi16` is unused by the gate (the light bar
// cannot be measured there), but the value must still be a real SGR, not a throw.
describe("16 colours", () => {
  test("a light token still produces an SGR at level 1", () => {
    expect(ansi16.hex(tokens.light.subtle)("X")).toContain("\u001b[");
  });
});
