/**
 * Render Markdown to an ANSI string for the terminal (bold, headings, lists,
 * inline code, fenced code blocks). The result is embedded in an Ink `<Text>`.
 *
 * Pure and synchronous: `marked` is configured without async extensions.
 *
 * ONE renderer per MODE (docs/feat/tui-light-theme.md S4). `marked-terminal`'s
 * defaults are dark-only — ANSI yellow inline code and blue links on a white
 * terminal are barely legible — so light mode paints the `md.*` tokens the
 * contrast gate measures (`theme-contrast.test.ts`) and highlights fences with
 * the light `syntax.*` tokens. Dark mode gets NO options at all, so its output is
 * byte-identical to the singleton this module used to configure.
 *
 * AGENTS §7: this is presentation data read from the token table, in a pure
 * module — the components only embed the string.
 */
import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlightTheme } from "./read-highlight.ts";
import { type ThemeMode, colorStyler, themeMode, tokens } from "./theme.ts";

type Styler = (s: string) => string;

/**
 * The light renderer's options: the `md.*` tokens, with the ATTRIBUTES the
 * library's defaults carry (bold headings, italic quotes, an underlined link)
 * kept, because those are emphasis, not colour — only the colour moves. The
 * mode's OWN tokens are read, not the active palette's, so the renderer for a
 * mode never paints another mode's values.
 *
 * Tables get their own treatment (Review fix round 2, LOW 4). `marked-terminal`
 * hands `tableOptions` to `cli-table3`, whose `style.head`/`style.border` are
 * resolved through `@colors/colors` (`cell.js:218-222`) — NAMED colours only, no
 * hex, so no token can be passed that way and the library's defaults
 * (`head: ['red']`, `border: ['grey']`, `utils.js:234-235`) are DARK-only paint.
 * Light therefore drops both to the terminal's own foreground, keeps the head's
 * BOLD (emphasis, as dark's is), and paints the frame from the `border` token in
 * the `table` styler — which runs on the finished, already-measured string, so
 * adding SGR there cannot disturb cli-table3's column widths.
 */
function lightOptions(): Record<string, unknown> {
  const md = tokens.light.md;
  const border = tokens.light.border;
  const fg = (color: string): Styler => chalk.hex(color) as unknown as Styler;
  const plain: Styler = (s) => s;
  return {
    code: fg(md.code),
    codespan: fg(md.code),
    heading: chalk.hex(md.heading).bold as unknown as Styler,
    firstHeading: chalk.hex(md.firstHeading).underline.bold as unknown as Styler,
    blockquote: chalk.hex(md.quote).italic as unknown as Styler,
    html: fg(md.quote),
    del: chalk.hex(md.del).strikethrough as unknown as Styler,
    link: fg(md.link),
    href: chalk.hex(md.link).underline as unknown as Styler,
    // Not colours: kept from the defaults so the two modes differ only in hue.
    hr: chalk.reset,
    listitem: plain,
    // The FRAME is the light `border` token; the cells stay the terminal's own
    // foreground (their content is already styled by `codespan`, `strong`, …).
    table: ((s: string) =>
      s.replace(/[│─┌┐└┘├┤┬┴┼]+/gu, (frame) => chalk.hex(border)(frame))) as Styler,
    tableOptions: { style: { head: ["bold"], border: [] } },
    paragraph: chalk.reset,
    strong: chalk.bold,
    em: chalk.italic,
    text: plain,
  };
}

/** The five entities `marked` escapes link text and autolink hrefs with. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const unescapeHtml = (s: string): string =>
  s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * THE link renderer of both modes (docs/feat/tui-clickable-links.md §3), laid
 * over `marked-terminal`'s: `text (href)`, or `href` alone when the text is the
 * address. Never an OSC 8 hyperlink — the library emits one wherever its
 * environment probe says so, which hides the target behind the text, lets any
 * scheme reach the terminal, and survives `stripAnsi` into a copied selection.
 * The visible address is what the TUI's own click opens (`links.ts`).
 */
function linkRenderer(link: Styler, href: Styler) {
  return {
    renderer: {
      link(target: string, _title: string | null | undefined, text: string): string {
        const shown = unescapeHtml(text.replace(SGR, ""));
        return link(
          shown !== "" && shown !== unescapeHtml(target)
            ? `${text} (${href(target)})`
            : href(target),
        );
      },
    },
  };
}

/** One `Marked` per mode, built on first use (`Marked` is exported, marked.d.ts:579). */
const renderers = new Map<ThemeMode, Marked>();

function rendererFor(mode: ThemeMode): Marked {
  let marked = renderers.get(mode);
  if (!marked) {
    if (mode === "dark") {
      // No options, so `marked-terminal`'s defaults (named ANSI colours) are what
      // dark mode paints; the link styles repeat those defaults (the dark
      // `md.link` token is the library's own blue).
      const link = colorStyler(tokens.dark.md.link);
      marked = new Marked(
        markedTerminal(),
        linkRenderer(link, (s) => link(chalk.underline(s))),
      );
    } else {
      const options = lightOptions();
      marked = new Marked(
        markedTerminal(options, { theme: highlightTheme("light") }),
        linkRenderer(options.link as Styler, options.href as Styler),
      );
    }
    renderers.set(mode, marked);
  }
  return marked;
}

/**
 * `text` as ANSI, in `mode` (default: the active palette). The mode is read at
 * CALL time — never captured at import — so a mode decided before the first
 * frame reaches every later render.
 */
export function renderMarkdown(text: string, mode: ThemeMode = themeMode()): string {
  const out = rendererFor(mode).parse(text, { async: false });
  return (typeof out === "string" ? out : text).replace(/\n+$/, "");
}
