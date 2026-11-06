import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { renderMarkdown } from "../src/markdown.ts";
import { setThemeMode, tokens } from "../src/theme.ts";

/**
 * Fix round 2, Review LOW 4 (docs/feat/tui-light-theme.md): a Markdown TABLE in
 * light mode must be painted from the light tokens, not from `cli-table3`'s
 * defaults.
 *
 * `lightOptions()` passed no `tableOptions`, so the library's own style applied:
 * `head: ['red']` → `\x1b[31m`, `border: ['grey']` → `\x1b[90m`
 * (`cli-table3/src/utils.js:234-235`). Neither is a token, and both are the DARK
 * defaults — the same class of bug as HIGH 1, on the one path it left out.
 */

const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
  setThemeMode("light");
});
afterAll(() => {
  setThemeMode("dark");
  chalk.level = level;
});

const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

/** The SGR our own chalk OPENS for a token (the same styler the renderer gets). */
const open = (color: string): string => chalk.hex(color)("X").replace("X\u001b[39m", "");

describe("LOW 4: a light Markdown table is painted from the light tokens", () => {
  test("no library default colour survives (no red head, no grey border)", () => {
    const out = renderMarkdown(TABLE, "light");
    // Mutation: drop `tableOptions` → `\x1b[31m a ` and `\x1b[90m┌` here.
    expect(out).not.toContain("\u001b[31m");
    expect(out).not.toContain("\u001b[90m");
  });

  test("the frame is the `border` token", () => {
    const out = renderMarkdown(TABLE, "light");
    expect(out).toContain(`${open(tokens.light.border)}┌`);
    expect(out).toContain(`${open(tokens.light.border)}│`);
  });

  test("the head row is bold (emphasis, as dark), the body cells plain foreground", () => {
    const out = renderMarkdown(TABLE, "light");
    // Only the FRAME carries a colour: strip the SGR and the grid is the library's
    // own, with no cell painted red and no grey default anywhere.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR, the subject here
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toBe("┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ 1 │ 2 │\n└───┴───┘");
    expect(out).toContain("\u001b[1m a \u001b[22m");
    expect(out).toContain("\u001b[1m b \u001b[22m");
    // The body cells are wrapped in NOTHING but the frame's own SGR.
    expect(out).toContain("\u001b[39m 1 \u001b[");
  });

  test("dark keeps the library's own table colours, byte for byte", () => {
    // The dark path must NOT change: it is the pinned `markedTerminal()` default.
    const out = renderMarkdown(TABLE, "dark");
    expect(out).toContain("\u001b[31m a ");
    expect(out).toContain("\u001b[90m┌");
  });
});
