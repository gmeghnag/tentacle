import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { renderMarkdown } from "../src/markdown.ts";
import { setThemeMode, tokens } from "../src/theme.ts";

describe("renderMarkdown", () => {
  test("returns a non-empty string preserving the words", () => {
    const out = renderMarkdown("**bold** and `code`");
    expect(typeof out).toBe("string");
    expect(out).toContain("bold");
    expect(out).toContain("code");
  });

  test("renders a fenced code block", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain("const x = 1");
  });

  test("does not end with trailing newlines", () => {
    const out = renderMarkdown("hello");
    expect(out.endsWith("\n")).toBe(false);
  });
});

// ── The palette reaches Markdown (docs/feat/tui-light-theme.md S4, HIGH 1) ───
//
// Assistant text is most of the screen, and `marked-terminal`'s defaults are
// DARK-ONLY: ANSI yellow inline code on a white terminal is unreadable. So the
// renderer is built per mode (`new Marked(…)`), and this suite pins both halves:
// dark is byte-identical to the singleton it replaced, light paints the `md.*`
// tokens the contrast gate measures.
//
// The mode is PROCESS-WIDE and Bun shares the module across test files, so it is
// reset after every test AND at the end of the file.

const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
  setThemeMode("dark");
});
afterEach(() => {
  setThemeMode("dark");
});
afterAll(() => {
  setThemeMode("dark");
  chalk.level = level;
});

/**
 * Dark output, captured from the pre-change `marked.use(markedTerminal())`
 * singleton at `chalk.level 3` (whole-file parity with that capture is proven in
 * the task doc's Execution; a fence is excluded here because cli-highlight's OWN
 * chalk decides its level, not ours).
 */
const DARK_GOLDEN = {
  inline: "\u001b[0m\u001b[1mbold\u001b[22m and \u001b[33mcode\u001b[39m\u001b[0m",
  heading:
    "\u001b[35m\u001b[4m\u001b[1m# Title\u001b[22m\u001b[24m\u001b[39m\n\n\u001b[32m\u001b[1m## Sub\u001b[22m\u001b[39m\n\n\u001b[32m\u001b[1m### Sub3\u001b[22m\u001b[39m",
  link: "\u001b[0mA \u001b[34mlink (\u001b[34m\u001b[4mhttps://example.com\u001b[24m\u001b[39m\u001b[34m)\u001b[39m here\u001b[0m",
  quote:
    "\u001b[90m\u001b[3m    \u001b[0mquoted\u001b[0m\u001b[23m\u001b[39m\n\u001b[90m\u001b[3m    \u001b[0mmore\u001b[0m\u001b[23m\u001b[39m",
  del: "\u001b[0m\u001b[2m\u001b[90m\u001b[9mgone\u001b[29m\u001b[39m\u001b[22m and \u001b[3mem\u001b[23m\u001b[0m",
} as const;

/** The SGR our own chalk OPENS for a token — the same styler the renderer gets. */
const open = (color: string): string => chalk.hex(color)("X").replace("X\u001b[39m", "");

describe("dark Markdown is byte-identical to the singleton it replaced", () => {
  test("inline code, headings, links, quotes, strikethrough", () => {
    setThemeMode("dark");
    expect({
      inline: renderMarkdown("**bold** and `code`"),
      heading: renderMarkdown("# Title\n\n## Sub\n\n### Sub3"),
      link: renderMarkdown("A [link](https://example.com) here"),
      quote: renderMarkdown("> quoted\n> more"),
      del: renderMarkdown("~~gone~~ and *em*"),
    }).toEqual(DARK_GOLDEN);
  });

  test("a fenced block still renders its code", () => {
    setThemeMode("dark");
    expect(renderMarkdown("```js\nconst x = 1;\n```")).toContain("const x = 1");
  });
});

describe("light Markdown paints the md.* tokens", () => {
  test("inline code is md.code, never the dark-only ANSI yellow", () => {
    setThemeMode("light");
    const out = renderMarkdown("**bold** and `code`");
    // Mutation: keep the dark renderer for light mode → `\x1b[33m` here, and the
    // `open()` assertion fails.
    expect(out).toContain(`${open(tokens.light.md.code)}code`);
    expect(out).not.toContain("\u001b[33m");
  });

  test("headings use md.firstHeading and md.heading", () => {
    setThemeMode("light");
    const out = renderMarkdown("# Title\n\n## Sub");
    expect(out).toContain(open(tokens.light.md.firstHeading));
    expect(out).toContain(open(tokens.light.md.heading));
    expect(out).toContain("Title");
    expect(out).toContain("Sub");
    // Mutation: the light renderer keeps the defaults → magenta `\x1b[35m`.
    expect(out).not.toContain("\u001b[35m");
    expect(out).not.toContain("\u001b[32m");
  });

  test("a link uses md.link", () => {
    setThemeMode("light");
    const out = renderMarkdown("A [link](https://example.com) here");
    expect(out).toContain(`${open(tokens.light.md.link)}link (`);
    expect(out).not.toContain("\u001b[34m");
  });

  test("a blockquote uses md.quote, a stray `<div>` its grey", () => {
    setThemeMode("light");
    expect(renderMarkdown("> quoted")).toContain(open(tokens.light.md.quote));
    // Mutation: no `html` colour → marked-terminal's default `chalk.gray` (`\x1b[90m`).
    expect(renderMarkdown("<div>html</div>")).toBe(
      chalk.hex(tokens.light.md.quote)("<div>html</div>"),
    );
  });

  test("strikethrough uses md.del (and keeps the strike attribute)", () => {
    setThemeMode("light");
    const out = renderMarkdown("~~gone~~");
    expect(out).toContain("\u001b[9m");
    expect(out).toContain(`${open(tokens.light.md.del)}\u001b[9mgone`);
  });

  test("a fenced block is highlighted with the light syntax tokens", () => {
    setThemeMode("light");
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    // Mutation: no `theme` passed → cli-highlight's default (blue `\x1b[34m`, or
    // plain, where the `open()` assertion fails).
    expect(out).toContain(`${open(tokens.light.syntax.keyword)}const`);
    expect(out).toContain(`${open(tokens.light.syntax.number)}1`);
    expect(out).not.toContain("\u001b[34m");
  });

  test("switching back to dark restores the dark rendering", () => {
    setThemeMode("light");
    renderMarkdown("`code`");
    setThemeMode("dark");
    // Mutation: one renderer, built once → light's SGR here.
    expect(renderMarkdown("**bold** and `code`")).toBe(DARK_GOLDEN.inline);
  });
});
