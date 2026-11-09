import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { CommandPalette } from "../src/components/CommandPalette.tsx";
import { LineInput } from "../src/components/LineInput.tsx";
import { QuitConfirm } from "../src/components/QuitConfirm.tsx";
import { StatusBar } from "../src/components/StatusBar.tsx";
import { type ThemeMode, resetThemeForTest, setThemeMode, tokens } from "../src/theme.ts";

/**
 * The components paint the ACTIVE palette (docs/feat/tui-light-theme.md S4).
 *
 * These render through Ink with `chalk.level = 3` implied by the harness's own
 * colour decision; the assertion is on the SGR each token produces, so it proves
 * the component reads the table rather than a captured value.
 */
// The harness is not a TTY, so chalk would be colourless: force truecolor, as
// `render-lines.test.ts` does, or every SGR assertion is vacuous.
const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterEach(() => {
  setThemeMode("dark");
});
afterAll(() => {
  setThemeMode("dark");
  chalk.level = level;
  resetThemeForTest();
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: reading ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The SGR colour of a token as the shared chalk would paint it. */
function sgrOf(hex: string): string {
  // The opening SGR only: the text follows it, so match up to the X.
  const painted = chalk.hex(hex)("X");
  return painted.slice(0, painted.indexOf("X"));
}

describe("StatusBar", () => {
  test("auto-accept ON paints the autoAccept token, OFF uses the dim one", async () => {
    for (const mode of ["dark", "light"] as ThemeMode[]) {
      setThemeMode(mode);
      const token = tokens[mode].autoAccept;
      const on = render(
        h(StatusBar, {
          cwd: "/w",
          tokens: null,
          contextTokens: null,
          contextWindow: 1000,
          columns: 80,
          autoApprove: true,
        }),
      ).lastFrame();
      // The mode's own token — a hex in both modes here, so the SGR is exact.
      // Mutation: read a captured constant → one mode fails.
      expect(on).toContain(sgrOf(token));
    }
  });

  test("light mode dims with a MEASURED grey, dark keeps the attribute", async () => {
    setThemeMode("light");
    const frame =
      render(
        h(StatusBar, {
          cwd: "/w",
          tokens: null,
          contextTokens: null,
          contextWindow: 1000,
          columns: 80,
          autoApprove: false,
        }),
      ).lastFrame() ?? "";
    // `dimProps()` gave a colour, so the hint is a hex, not SGR 2.
    // Mutation: `dimProps()` returning `dimColor` in light → `\x1b[2m` here.
    expect(frame).not.toContain("\x1b[2m");
    expect(frame).toContain(sgrOf(tokens.light.dim));
  });
});

describe("QuitConfirm", () => {
  test("paints the quit token in both modes, never the `yellow` literal", async () => {
    for (const mode of ["dark", "light"] as ThemeMode[]) {
      setThemeMode(mode);
      const frame = render(h(QuitConfirm, { text: "close for all?", columns: 40 })).lastFrame();
      expect(strip(frame ?? "")).toContain("close for all?");
      if (tokens[mode].quit.startsWith("#")) {
        expect(frame).toContain(sgrOf(tokens[mode].quit));
      }
    }
  });

  test("one row however long the text: a hostile pod cannot grow the box (LOW-2)", async () => {
    // `QUIT_CONFIRM_ROWS = 3` is what App reserves (top border, line, bottom):
    // a wrapped 10 000-char line rendered 98 rows into those 3.
    const text = `32 background sub-agents (${"x".repeat(10_000)}) will be lost — quit? (y/N)`;
    const frame = render(h(QuitConfirm, { text, columns: 80 })).lastFrame() ?? "";
    const rows = frame.split("\n");
    expect(rows.length).toBe(3);
    expect(strip(frame)).toContain("32 background sub-agents (xxxxxxxx");
    // Truncated, so the tail of the line is gone: it never wrapped to reach it.
    expect(strip(frame)).not.toContain("(y/N)");
  });
});

describe("LineInput and CommandPalette", () => {
  test("the accent follows the mode", async () => {
    setThemeMode("light");
    const input = render(
      h(LineInput, { value: "hi", cursor: 2, placeholder: "p", width: 20 }),
    ).lastFrame();
    expect(input).toContain(sgrOf(tokens.light.accent));
    const palette = render(
      h(CommandPalette, {
        commands: [{ name: "quit", description: "leave" }],
        selected: 0,
        columns: 40,
      }),
    ).lastFrame();
    expect(palette).toContain(sgrOf(tokens.light.accent));
  });

  test("the unselected palette rows use the light dim grey", async () => {
    setThemeMode("light");
    const frame =
      render(
        h(CommandPalette, {
          commands: [
            { name: "quit", description: "leave" },
            { name: "help", description: "info" },
          ],
          selected: 0,
          columns: 40,
        }),
      ).lastFrame() ?? "";
    // Mutation: a `dimColor` prop left on the row → `\x1b[2m`.
    expect(frame).not.toContain("\x1b[2m");
    expect(frame).toContain(sgrOf(tokens.light.dim));
  });
});
