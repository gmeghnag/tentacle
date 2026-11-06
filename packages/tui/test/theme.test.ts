import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import {
  type ThemeMode,
  dashedRule,
  palette,
  setThemeMode,
  theme,
  themeMode,
  tokens,
} from "../src/theme.ts";

// The token table (docs/feat/tui-light-theme.md S2/S3). Two properties are pinned
// here, and they pull in opposite directions — which is the point:
//   1. DARK is byte-identical to what `theme.ts` painted before the table existed
//      (the SGR below was captured from the pre-change module at `chalk.level 3`).
//   2. The two modes expose the SAME key set, so a token added to one is not
//      silently missing from the other.
// Every assertion names its mutation in a comment (AGENTS §9).

const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
  setThemeMode("dark");
});
afterEach(() => {
  // The palette is PROCESS-WIDE and Bun shares the module across test files, so a
  // mode left on `light` would repaint every later suite. Reset after each test
  // AND after the file (a `test.each`-style abort can skip `afterEach`).
  setThemeMode("dark");
});
afterAll(() => {
  setThemeMode("dark");
  chalk.level = level;
});

/** Today's dark SGR, captured from `theme.ts` BEFORE the token table existed. */
const DARK_GOLDEN: Record<string, string> = {
  accent: "\u001b[38;2;6;182;212mX\u001b[39m",
  subtle: "\u001b[38;2;140;140;140mX\u001b[39m",
  notice: "\u001b[38;2;140;170;238mX\u001b[39m",
  hidden: "\u001b[8mX\u001b[28m",
  success: "\u001b[38;2;78;201;116mX\u001b[39m",
  error: "\u001b[38;2;237;84;84mX\u001b[39m",
  warn: "\u001b[38;2;224;175;74mX\u001b[39m",
  "diff.addBg": "\u001b[48;2;2;40;0mX\u001b[49m",
  "diff.addFg": "\u001b[38;2;248;248;242mX\u001b[39m",
  "diff.addGutter": "\u001b[38;2;110;200;96mX\u001b[39m",
  "diff.addWord": "\u001b[48;2;4;71;0m\u001b[38;2;248;248;242mX\u001b[39m\u001b[49m",
  "diff.delBg": "\u001b[48;2;61;1;0mX\u001b[49m",
  "diff.delFg": "\u001b[38;2;248;248;242mX\u001b[39m",
  "diff.delGutter": "\u001b[38;2;230;100;100mX\u001b[39m",
  "diff.delWord": "\u001b[48;2;92;2;0m\u001b[38;2;248;248;242mX\u001b[39m\u001b[49m",
  "diff.border": "\u001b[38;2;88;88;96mX\u001b[39m",
  dashedRule: "\u001b[38;2;88;88;96m╌╌╌\u001b[39m",
  "message.dark.bg": "\u001b[48;2;55;55;55mX\u001b[49m",
  "message.dark.queuedFg": "\u001b[38;2;140;140;140mX\u001b[39m",
};

function probe(): Record<string, string> {
  return {
    accent: theme.accent("X"),
    subtle: theme.subtle("X"),
    notice: theme.notice("X"),
    hidden: theme.hidden("X"),
    success: theme.success("X"),
    error: theme.error("X"),
    warn: theme.warn("X"),
    "diff.addBg": theme.diff.addBg("X"),
    "diff.addFg": theme.diff.addFg("X"),
    "diff.addGutter": theme.diff.addGutter("X"),
    "diff.addWord": theme.diff.addWord("X"),
    "diff.delBg": theme.diff.delBg("X"),
    "diff.delFg": theme.diff.delFg("X"),
    "diff.delGutter": theme.diff.delGutter("X"),
    "diff.delWord": theme.diff.delWord("X"),
    "diff.border": theme.diff.border("X"),
    dashedRule: dashedRule(3),
    "message.dark.bg": theme.message.bg("X"),
    "message.dark.queuedFg": theme.message.queuedFg("X"),
  };
}

describe("dark is byte-identical to the pre-table theme", () => {
  test("every dark styler paints the same SGR", () => {
    setThemeMode("dark");
    expect(probe()).toEqual(DARK_GOLDEN);
  });

  test("switching back to dark restores it exactly", () => {
    setThemeMode("light");
    setThemeMode("dark");
    // Mutation: a styler captured at module load (never rebuilt) → light's SGR here.
    expect(probe()).toEqual(DARK_GOLDEN);
  });
});

describe("setThemeMode changes what is painted", () => {
  test("the light stylers are the light tokens, and dark's are restored", () => {
    setThemeMode("light");
    expect(palette().accent).toBe(tokens.light.accent);
    // Mutation: a styler captured at module load (`const X = theme.accent`) or an
    // alias a component keeps → dark's accent, while `palette()` says light.
    expect(theme.accent("X")).toBe(chalk.hex(tokens.light.accent)("X"));
    expect(palette().accent).not.toBe(tokens.dark.accent);
    setThemeMode("dark");
    expect(theme.accent("X")).toBe(chalk.hex(tokens.dark.accent)("X"));
  });

  test("every styler follows the mode, not just the accent", () => {
    const sgrOf = (mode: ThemeMode): string[] => {
      setThemeMode(mode);
      return [
        theme.accent("X"),
        theme.subtle("X"),
        theme.autoAccept("X"),
        theme.notice("X"),
        theme.success("X"),
        theme.error("X"),
        theme.warn("X"),
        theme.diff.addFg("X"),
        theme.diff.addBg("X"),
        theme.diff.border("X"),
        theme.message.bg("X"),
        theme.message.queuedFg("X"),
      ];
    };
    const darkSet = sgrOf("dark");
    const lightSet = sgrOf("light");
    // Mutation: one styler left pointing at DARK → one equal element.
    for (const [i, dark] of darkSet.entries()) {
      expect(lightSet[i]).not.toBe(dark);
    }
  });
});

describe("the two modes are the same shape", () => {
  test("every token key exists in both modes, at every depth", () => {
    const keysOf = (value: unknown, prefix = ""): string[] => {
      if (typeof value !== "object" || value === null || typeof value === "function") {
        return [prefix];
      }
      return Object.entries(value).flatMap(([k, v]) =>
        keysOf(v, prefix === "" ? k : `${prefix}.${k}`),
      );
    };
    setThemeMode("dark");
    const dark = keysOf(palette()).sort();
    setThemeMode("light");
    const light = keysOf(palette()).sort();
    // Mutation: add a token to `tokens.dark` only → the lists differ.
    expect(light).toEqual(dark);
  });

  test("themeMode() reports the active mode", () => {
    expect(themeMode() as ThemeMode).toBe("dark");
    setThemeMode("light");
    expect(themeMode()).toBe("light");
  });
});
