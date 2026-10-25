/**
 * Centralised colour palette for the TUI, as chalk stylers.
 *
 * Tuned for a dark terminal (the common case): diff lines use dark background
 * tints with bright, readable foregrounds, and changed words get a brighter
 * tint on top. The brand accent is a single distinctive cyan; chalk
 * auto-disables colour when stdout is not a TTY, so the same strings degrade
 * to plain text in tests and pipes.
 */
import chalk from "chalk";

/**
 * The single source of truth for the brand accent hex. Both colour paths read
 * it: the chalk path via `chalk.hex(accentHex)` (theme tokens) and the
 * component path via its `color=` props. Keep it here — a stray hard-coded hex
 * anywhere re-scatters the colour.
 */
export const accentHex = "#06b6d4";

/**
 * User-message rows: a full-width background tint and the grey of a queued
 * one, as RGB triples. `dark` is the default; `light` is the matching tint for
 * a light terminal (the TUI has no light-mode switch yet).
 */
export const messageRgb = {
  // #373737 (owner, 2026-10-25).
  dark: { bg: [55, 55, 55], queuedFg: [140, 140, 140] },
  light: { bg: [232, 232, 240], queuedFg: [110, 110, 120] },
} as const;

type Rgb = readonly [number, number, number];

/** The stylers a message row is dressed with. */
export interface MessageStyle {
  readonly bg: (s: string) => string;
  readonly queuedFg: (s: string) => string;
}

function messageStyle(c: { readonly bg: Rgb; readonly queuedFg: Rgb }): MessageStyle {
  return { bg: chalk.bgRgb(...c.bg), queuedFg: chalk.rgb(...c.queuedFg) };
}

/**
 * Syntax colours for file reads (highlight.js token classes → RGB). `dark` is
 * the default; `light` is the darker-on-white set for a light terminal (no
 * light-mode switch yet — same status as `messageRgb`).
 */
export const syntaxRgb = {
  dark: {
    keyword: [198, 120, 221],
    string: [152, 195, 121],
    number: [209, 154, 102],
    comment: [110, 118, 129],
    title: [97, 175, 239],
    type: [229, 192, 123],
    meta: [86, 182, 194],
    tag: [224, 108, 117],
  },
  light: {
    keyword: [136, 57, 239],
    string: [64, 128, 24],
    number: [190, 90, 20],
    comment: [120, 126, 135],
    title: [30, 102, 245],
    type: [160, 110, 10],
    meta: [14, 130, 150],
    tag: [200, 40, 60],
  },
} as const;

export const theme = {
  /** Brand accent (cyan) — assistant bullets, in-progress, highlights. */
  accent: chalk.hex(accentHex),
  /** De-emphasised grey for metadata, context, hints. */
  subtle: chalk.rgb(140, 140, 140),
  success: chalk.rgb(78, 201, 116),
  error: chalk.rgb(237, 84, 84),
  warn: chalk.rgb(224, 175, 74),
  diff: {
    /** Added line: dark-green background (Claude-Code style). */
    addBg: chalk.bgRgb(2, 40, 0),
    /** Line text: explicit near-white (the default foreground is unreadable on light themes). */
    addFg: chalk.rgb(248, 248, 242),
    /** Line number and `+` marker: bright green. */
    addGutter: chalk.rgb(110, 200, 96),
    /** Changed word within an added line: brighter green background. */
    addWord: chalk.bgRgb(4, 71, 0).rgb(248, 248, 242),
    /** Removed line: dark-red background. */
    delBg: chalk.bgRgb(61, 1, 0),
    delFg: chalk.rgb(248, 248, 242),
    /** Line number and `-` marker: bright red. */
    delGutter: chalk.rgb(230, 100, 100),
    /** Changed word within a removed line: brighter red background. */
    delWord: chalk.bgRgb(92, 2, 0).rgb(248, 248, 242),
    /** Subtle dashed frame around a diff block. */
    border: chalk.rgb(88, 88, 96),
  },
  /** Row style of a user message (sent or queued); see `messageRgb`. */
  message: {
    dark: messageStyle(messageRgb.dark),
    light: messageStyle(messageRgb.light),
  },
} as const;

/** The dashed horizontal rule used as a diff frame's top/bottom border. */
export function dashedRule(width: number): string {
  return theme.diff.border("╌".repeat(Math.max(1, width)));
}
