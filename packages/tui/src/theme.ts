/**
 * Centralised colour palette for the TUI: ONE token table, two modes.
 *
 * Every colour the TUI paints is a value in `tokens` (docs/feat/tui-light-theme.md).
 * `buildTheme(tokens)` turns the active mode's tokens into the chalk stylers the
 * render path uses; `palette()` exposes the same tokens to the components, so
 * `<Text color={…}>` reads the SAME value the chalk path does.
 *
 * Two modes exist because a palette tuned for a dark terminal is unreadable on a
 * light one: diff lines use tinted backgrounds with a near-white foreground, and
 * `subtle` is a mid grey. `dark` is the original palette, byte for byte; `light`
 * is a darker-on-white set whose WCAG ratios (truecolor AND after chalk's 256
 * downgrade) are pinned by `test/theme-contrast.test.ts`. The mode is decided
 * once per launch, before the first row exists.
 *
 * Light tokens are hexes, not RGB triples, for one measured reason: chalk's 256
 * downgrade (`rgbToAnsi256`) uses the 24-step grey ramp only when r=g=b and the
 * 6×6×6 cube otherwise, so a near-grey like `#6b6b6f` lands on the cube (#878787,
 * 3.59:1) while the exact grey `#6b6b6b` lands on the ramp (5.25:1). Keep the
 * greys exactly grey.
 */
import chalk from "chalk";
import { type Rgb, type ThemeSetting, resolveMode } from "./terminal-background.ts";

export type { ThemeSetting };

/** Which palette is painted: decided once, before the first frame. */
export type ThemeMode = "dark" | "light";

/** An opaque colour value: a hex string, or a named chalk colour in dark mode. */
type Color = string;

interface DiffTokens {
  readonly addBg: Color;
  readonly addFg: Color;
  readonly addGutter: Color;
  readonly addWordBg: Color;
  readonly addWordFg: Color;
  readonly delBg: Color;
  readonly delFg: Color;
  readonly delGutter: Color;
  readonly delWordBg: Color;
  readonly delWordFg: Color;
  readonly border: Color;
}

interface MessageTokens {
  readonly bg: Color;
  readonly queuedFg: Color;
}

interface StatusTokens {
  readonly linkError: Color;
  readonly linkWarn: Color;
  readonly scrolled: Color;
}

interface MeterTokens {
  readonly low: Color;
  readonly mid: Color;
  readonly high: Color;
}

interface SyntaxTokens {
  readonly keyword: Color;
  readonly string: Color;
  readonly number: Color;
  readonly comment: Color;
  readonly title: Color;
  readonly type: Color;
  readonly meta: Color;
  readonly tag: Color;
}

interface MarkdownTokens {
  readonly code: Color;
  readonly firstHeading: Color;
  readonly heading: Color;
  readonly quote: Color;
  readonly del: Color;
  readonly link: Color;
}

/** Every colour the TUI paints. Both modes hold exactly these keys. */
export interface Tokens {
  readonly accent: Color;
  readonly autoAccept: Color;
  readonly subtle: Color;
  /** The dim rows: SGR 2 in dark (terminal-defined, free), an explicit grey in light. */
  readonly dim: Color;
  /** `dim` as an Ink prop: dark keeps `dimColor`, light passes the measured grey. */
  readonly dimIsAttribute: boolean;
  readonly gutter: Color;
  readonly notice: Color;
  readonly hidden: Color;
  readonly success: Color;
  readonly error: Color;
  readonly warn: Color;
  readonly quit: Color;
  readonly border: Color;
  readonly status: StatusTokens;
  readonly meter: MeterTokens;
  readonly diff: DiffTokens;
  readonly message: MessageTokens;
  readonly syntax: SyntaxTokens;
  readonly md: MarkdownTokens;
}

/**
 * The dark palette: EXACTLY the values the module painted before the table
 * existed (pinned byte for byte by `theme.test.ts`). Named chalk colours stay
 * named where they already were, so a 16-colour terminal keeps its own idea of
 * "yellow" instead of a downgrade.
 */
const DARK: Tokens = {
  accent: "#06b6d4",
  autoAccept: "#fec20a",
  subtle: "#8c8c8c",
  dim: "dim",
  dimIsAttribute: true,
  gutter: "gray",
  notice: "#8caaee",
  hidden: "hidden",
  success: "#4ec974",
  error: "#ed5454",
  warn: "#e0af4a",
  quit: "yellow",
  border: "gray",
  status: { linkError: "red", linkWarn: "yellow", scrolled: "yellow" },
  meter: { low: "green", mid: "yellow", high: "red" },
  diff: {
    addBg: "#022800",
    addFg: "#f8f8f2",
    addGutter: "#6ec860",
    addWordBg: "#044700",
    addWordFg: "#f8f8f2",
    delBg: "#3d0100",
    delFg: "#f8f8f2",
    delGutter: "#e66464",
    delWordBg: "#5c0200",
    delWordFg: "#f8f8f2",
    border: "#585860",
  },
  message: { bg: "#373737", queuedFg: "#8c8c8c" },
  syntax: {
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    comment: "#6e7681",
    title: "#61afef",
    type: "#e5c07b",
    meta: "#56b6c2",
    tag: "#e06c75",
  },
  md: {
    // The marked-terminal defaults, unchanged: named so the two modes share a key set.
    code: "yellow",
    firstHeading: "magenta",
    heading: "green",
    quote: "gray",
    del: "gray",
    link: "blue",
  },
};

/**
 * The light palette: darker-on-white, 4.5:1 on white AND Solarized Light `#fdf6e3`,
 * AND after chalk's real 256 downgrade — except `accent`, the ONE named exception
 * the owner accepted (Q3: no cyan-like 256 bucket reaches 4.5). `notice` was a
 * second for one round; the owner's fix-round answer settled it at `#2f4ba8`
 * (7.80 / 7.23 / 5.61), so the gate is "all but the accent" again.
 */
const LIGHT: Tokens = {
  accent: "#0e7490",
  autoAccept: "#a84a00",
  subtle: "#6b6b6b",
  dim: "#6b6b6b",
  dimIsAttribute: false,
  gutter: "#6b6b6b",
  notice: "#2f4ba8",
  hidden: "hidden",
  success: "#084718",
  error: "#b21428",
  warn: "#8f4c00",
  quit: "#8f4c00",
  border: "#8c8c8c",
  status: { linkError: "#b21428", linkWarn: "#8f4c00", scrolled: "#8f4c00" },
  meter: { low: "#084718", mid: "#8f4c00", high: "#b21428" },
  diff: {
    addBg: "#dafbe1",
    addFg: "#1a1a1a",
    addGutter: "#0f4c0f",
    addWordBg: "#aceebb",
    addWordFg: "#1a1a1a",
    delBg: "#ffe1e1",
    delFg: "#1a1a1a",
    delGutter: "#b21428",
    delWordBg: "#ffb2b2",
    delWordFg: "#1a1a1a",
    border: "#8c8c8c",
  },
  message: { bg: "#eeeeee", queuedFg: "#5c5c5c" },
  syntax: {
    keyword: "#5f1cb2",
    string: "#146e14",
    number: "#9c4600",
    comment: "#646464",
    title: "#1446c8",
    type: "#784600",
    meta: "#0e4c5f",
    tag: "#b21428",
  },
  md: {
    code: "#953800",
    firstHeading: "#5f1cb2",
    heading: "#084718",
    quote: "#6b6b6b",
    del: "#6b6b6b",
    link: "#1446c8",
  },
};

export const tokens: Readonly<Record<ThemeMode, Tokens>> = { dark: DARK, light: LIGHT };

/** The stylers a message row is dressed with. */
export interface MessageStyle {
  readonly bg: (s: string) => string;
  readonly queuedFg: (s: string) => string;
}

/**
 * A colour value as a chalk function. Read at CALL time, never at import: a
 * module-load capture would freeze whatever `chalk.level` was then (`blink.ts`
 * documents that trap) and, after this table, would also freeze the mode.
 */
function ink(color: Color): Styler {
  if (color === "dim") {
    return chalk.dim;
  }
  if (color === "hidden") {
    return chalk.hidden;
  }
  if (color.startsWith("#")) {
    return chalk.hex(color);
  }
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
  if (rgb) {
    return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  // A named chalk colour: `"red"`, `"yellow"`, `"gray"`, …
  const named = (chalk as unknown as Record<string, Styler>)[color];
  if (typeof named !== "function") {
    throw new Error(`unknown colour token: ${JSON.stringify(color)}`);
  }
  return named;
}

/** A chalk styler: callable, and chainable (`.bold`, `.underline`, …) as before. */
export type Styler = ReturnType<typeof chalk.hex>;

/** A token colour value as a chalk styler — the export `read-highlight.ts` needs. */
export const colorStyler = (color: Color): Styler => ink(color) as Styler;

/** A message row's two stylers for a mode (what `theme.message` becomes). */
export function messageStyle(mode: ThemeMode): MessageStyle {
  return { bg: bg(tokens[mode].message.bg), queuedFg: ink(tokens[mode].message.queuedFg) };
}

/** Background variants (Ink's `bg…` equivalents for a token value). */
function bg(color: Color): Styler {
  if (color.startsWith("#")) {
    return chalk.bgHex(color);
  }
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
  if (rgb) {
    return chalk.bgRgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  throw new Error(`no background for colour token: ${JSON.stringify(color)}`);
}

/** The chalk stylers for one mode. */
function buildTheme(t: Tokens) {
  const fg = (value: Color): Styler => ink(value);
  return {
    /** Brand accent — assistant bullets, in-progress, highlights. */
    accent: fg(t.accent),
    /** The status bar's `⏵⏵ auto-accept on`. */
    autoAccept: fg(t.autoAccept),
    /** De-emphasised grey for metadata, context, hints. */
    subtle: fg(t.subtle),
    notice: fg(t.notice),
    /**
     * SGR conceal ("hidden"): draws the characters in the background colour, so
     * the cells are still OCCUPIED. The OFF half of a running call's blink is the
     * very same glyph under this styler (`fix/tui-blink-off-width`).
     */
    hidden: chalk.hidden,
    success: fg(t.success),
    error: fg(t.error),
    warn: fg(t.warn),
    diff: {
      addBg: bg(t.diff.addBg),
      addFg: fg(t.diff.addFg),
      addGutter: fg(t.diff.addGutter),
      addWord: (s: string) => bg(t.diff.addWordBg)(fg(t.diff.addWordFg)(s)),
      delBg: bg(t.diff.delBg),
      delFg: fg(t.diff.delFg),
      delGutter: fg(t.diff.delGutter),
      delWord: (s: string) => bg(t.diff.delWordBg)(fg(t.diff.delWordFg)(s)),
      border: fg(t.diff.border),
    },
    /** Row style of a user message (sent or queued). */
    message: {
      bg: bg(t.message.bg),
      queuedFg: fg(t.message.queuedFg),
    } satisfies MessageStyle,
  };
}

export type Theme = ReturnType<typeof buildTheme>;

/** The chalk path: an ES live binding, so existing `theme.accent(…)` call sites stay. */
export let theme: Theme = buildTheme(DARK);

let mode: ThemeMode = "dark";

/** Switch the palette. Called once, before the first frame (never mid-session). */
export function setThemeMode(next: ThemeMode): void {
  mode = next;
  theme = buildTheme(tokens[next]);
}

export function themeMode(): ThemeMode {
  return mode;
}

/** The component path: `<Text color={palette().accent}>`, read at render. */
export function palette(): Tokens {
  return tokens[mode];
}

/**
 * The dim prop, per mode: dark keeps Ink's `dimColor` (SGR 2 — free, and the
 * terminal decides); light needs a MEASURED grey, since SGR 2's contrast cannot
 * be computed. Spread it: `<Text {...dimProps()}>`.
 */
export function dimProps(): { readonly dimColor: true } | { readonly color: string } {
  const t = palette();
  return t.dimIsAttribute ? { dimColor: true } : { color: t.dim };
}

/** The dashed horizontal rule used as a diff frame's top/bottom border. */
export function dashedRule(width: number): string {
  return theme.diff.border("╌".repeat(Math.max(1, width)));
}

// ── Deciding the palette, once per process ──────────────────────────────────

/** What the probe needs from the outside world, all injectable. */
export interface ThemeIo {
  /** Whether a query is worth sending (`canProbe` in `terminal-background.ts`). */
  readonly canProbe: boolean;
  readonly probe: () => Promise<{
    readonly color: Rgb | null;
    readonly late: boolean;
    /** The head of a reply the timeout cut in half, for the late guard. */
    readonly residue?: string;
  }>;
  /** `process.env.COLORFGBG`: the fallback a terminal exports for exactly this. */
  readonly colorFgBg: string | undefined;
}

export interface PreparedTheme {
  readonly mode: ThemeMode;
  /**
   * A reply may still arrive: the probe timed out with the tty left raw. The
   * caller must guard Ink's stdin (`stepLateFilter`) or the reply lands in the
   * prompt as junk.
   */
  readonly late: boolean;
  /**
   * A reply the timeout cut in half, as the guard's starting `pending`. Empty on
   * the normal path, so nothing changes there.
   */
  readonly residue: string;
}

let prepared: Promise<PreparedTheme> | null = null;
let preparedLate = false;
let preparedResidue = "";

/**
 * Decide and APPLY the palette. The first call does the work; every later call in
 * the same process reuses it, so two mounts (the `--resume` picker, then the
 * runtime) cost one query and agree on the answer.
 *
 * Called first thing in `startTui` and `pickSession` — before Ink mounts, because
 * the answer has to be settled before the first row exists (`tui.theme` is not a
 * mid-session setting, Q8).
 */
export async function prepareTheme(setting: ThemeSetting, io: ThemeIo): Promise<PreparedTheme> {
  if (prepared === null) {
    prepared = decide(setting, io).then((result) => {
      setThemeMode(result.mode);
      preparedLate = result.late;
      preparedResidue = result.residue;
      return result;
    });
  }
  return prepared;
}

async function decide(setting: ThemeSetting, io: ThemeIo): Promise<PreparedTheme> {
  if (setting !== "auto") {
    // A forced setting never queries: the user already answered. `resolveMode` is
    // the ONE place the precedence lives (it is what `theme-prepare.test.ts` pins
    // through this function, so the two cannot drift).
    return { mode: resolveMode(setting, null, undefined), late: false, residue: "" };
  }
  if (io.canProbe) {
    const { color, late, residue } = await io.probe();
    // No colour: a sentinel means nothing more is coming; a timeout means a late
    // reply still might, so `late` drives the guard either way.
    return {
      mode: resolveMode("auto", color, io.colorFgBg),
      late,
      residue: residue ?? "",
    };
  }
  return { mode: resolveMode("auto", null, io.colorFgBg), late: false, residue: "" };
}

/** Whether the settled mode is waiting on a reply that may still arrive. */
export function themeProbeWasLate(): boolean {
  return preparedLate;
}

/**
 * The head of a reply the timeout cut in half: the late guard's starting
 * `pending`, so the tail that arrives after the mount is stripped with it.
 */
export function themeProbeResidue(): string {
  return preparedResidue;
}

/** Test-only: forget the memo, so a suite can decide again. */
export function resetThemeForTest(): void {
  prepared = null;
  preparedLate = false;
  preparedResidue = "";
}
