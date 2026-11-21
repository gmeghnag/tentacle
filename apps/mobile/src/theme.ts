/**
 * The design tokens — ONE module, no React, no logic (docs/feat/mobile-ui-polish.md
 * Design 1). Colours are the approved mockups' `renderVals()` tables, light and
 * dark; type, radii, sizes and spacing are the mockups' measures. The screen
 * picks a palette by `useColorScheme`; every primitive takes it as a prop.
 * (The pre-restyle alias names — `groupedBackground`, `secondaryLabel`, … — were
 * removed in Slice 6: every screen now reads the tokens.)
 *
 * The dark ramp, `drawer`, the E2 `band`/`bandOnSheet` surfaces and the radii are
 * docs/feat/mobile-chrome.md (S1, Owner Q-B/E2).
 */

export interface Palette {
  /** Grouped screen background (lists). */
  readonly bg: string;
  /** Chat screen background. */
  readonly page: string;
  readonly card: string;
  readonly sheet: string;
  /**
   * The sessions drawer's panel, one step BELOW `page` so the drawer reads as a
   * layer with no shadow (docs/feat/mobile-chrome.md Design 3).
   */
  readonly drawer: string;
  /**
   * The E2 section band: ONE full-width surface per section, always one step
   * above the ground it sits on (docs/feat/mobile-chrome.md Design 4).
   */
  readonly band: string;
  /** The band inside a sheet, whose own ground becomes `page` (Design 4). */
  readonly bandOnSheet: string;
  /** Secondary fill: user bubble, neutral button, text field. */
  readonly fill: string;
  /** Code block / inline code background (on a page or card). */
  readonly code: string;
  /** Code background on a sheet. */
  readonly codeOnSheet: string;
  readonly label: string;
  /** Secondary label. */
  readonly sec: string;
  readonly sep: string;
  /** Separator on the chat page. */
  readonly sepChat: string;
  /** Separator on a sheet. */
  readonly sepSheet: string;
  /** Accent for text and icons. */
  readonly accent: string;
  /** Accent for a filled button. */
  readonly accentFill: string;
  /** Text/icon on `accentFill`. */
  readonly onAccent: string;
  /** Accent-tinted background (badges, running row, icon tiles). */
  readonly tint: string;
  /**
   * The composer's round buttons (`+`, the mic) at rest: the accent at 10 %
   * light / 14 % dark (docs/feat/mobile-composer-buttons.md, mockup B).
   */
  readonly accentSoft: string;
  /** The same circle, stronger — recording, and the send slot when ready: 20 % / 26 %. */
  readonly accentSoftStrong: string;
  readonly green: string;
  readonly orange: string;
  readonly red: string;
  readonly warnBg: string;
  readonly warnText: string;
  /** Glass buttons and composer (the fallback when blur is off). */
  readonly glass: string;
  readonly glassBorder: string;
  readonly shadowOpacity: number;
  /**
   * The dim behind a sheet or an action sheet: the mockups' 0.35 on light; on
   * the black dark page 0.6, so the sheet separates (visual review N12).
   */
  readonly scrim: string;
  /** The camera's own chrome, always dark (Pair scanner). */
  readonly camera: string;
  readonly cameraAccent: string;
  readonly kw: string;
  readonly com: string;
  readonly addBg: string;
  readonly addStrong: string;
  readonly addText: string;
  readonly delBg: string;
  readonly delStrong: string;
  readonly delText: string;
  readonly dash: string;
  readonly switchOff: string;
}

const light: Palette = {
  bg: "#F2F2F7",
  page: "#FFFFFF",
  card: "#FFFFFF",
  sheet: "#FFFFFF",
  drawer: "#F7F7F8",
  band: "#FFFFFF",
  bandOnSheet: "#FFFFFF",
  fill: "#EFEFF4",
  code: "#F2F2F7",
  codeOnSheet: "#F2F2F7",
  label: "#000000",
  sec: "#636366",
  sep: "#C6C6C8",
  sepChat: "#D1D1D6",
  sepSheet: "#C6C6C8",
  accent: "#0E7490",
  accentFill: "#0E7490",
  onAccent: "#FFFFFF",
  tint: "#E0F4F8",
  accentSoft: "rgba(14,116,144,0.10)",
  accentSoftStrong: "rgba(14,116,144,0.20)",
  green: "#1E7B34",
  orange: "#B33000",
  red: "#C4001A",
  warnBg: "#FFF1DC",
  warnText: "#7A3300",
  glass: "rgba(255,255,255,0.82)",
  glassBorder: "rgba(0,0,0,0.08)",
  shadowOpacity: 0.12,
  scrim: "rgba(0,0,0,0.35)",
  camera: "#000000",
  cameraAccent: "#22D3EE",
  kw: "#9B2393",
  com: "#55606B",
  addBg: "#E3F5E8",
  addStrong: "#BFE8CB",
  addText: "#14612A",
  delBg: "#FCE8EA",
  delStrong: "#F6C4CA",
  delText: "#9F1020",
  dash: "#8E8E93",
  switchOff: "#C7C7CC",
};

const dark: Palette = {
  bg: "#1E1F21",
  page: "#1E1F21",
  card: "#28292C",
  sheet: "#28292C",
  drawer: "#19191B",
  band: "#242528",
  bandOnSheet: "#28292C",
  fill: "#313236",
  code: "#28292C",
  codeOnSheet: "#313236",
  label: "#EDEEF0",
  sec: "#A0A3A8",
  sep: "#37383C",
  sepChat: "#313236",
  sepSheet: "#3D3E42",
  accent: "#22D3EE",
  accentFill: "#06B6D4",
  onAccent: "#00191F",
  tint: "#0B2E36",
  accentSoft: "rgba(34,211,238,0.14)",
  accentSoftStrong: "rgba(34,211,238,0.26)",
  green: "#30D158",
  orange: "#FF9F0A",
  // `#FF6961` measures 4.4977:1 on B1's `fill` (#33332F) — under the 4.5 floor
  // F9 pins — so the red is lifted to #FF6D65 (4.61:1 on `fill`, 5.23 on `card`).
  // B3's lighter `fill` (#313236) keeps it above the floor.
  red: "#FF6D65",
  warnBg: "#3A2A0C",
  warnText: "#FFD08A",
  glass: "rgba(40,41,44,0.86)",
  glassBorder: "rgba(255,255,255,0.07)",
  shadowOpacity: 0.35,
  scrim: "rgba(0,0,0,0.45)",
  camera: "#000000",
  cameraAccent: "#22D3EE",
  kw: "#FF7AB2",
  com: "#8E9AA6",
  addBg: "#0F2A19",
  addStrong: "#1F5232",
  addText: "#7EE2A0",
  delBg: "#34141A",
  delStrong: "#64222B",
  delText: "#FFA3A8",
  dash: "#636366",
  switchOff: "#434448",
};

/**
 * The Figtree try-out's dark palette, "abisso petrolio" (docs/feat/mobile-theme-beta.md,
 * Owner decision 2026-11-21; Settings → Beta, OFF by default). The owner's hexes:
 * page #151B1D, text #D5DDDE / #98A6A8, separator #253033, raised fill (composer,
 * sheets, code/tool rows) #1D2528, accent #22D3EE, tint = rgba(34,211,238,.12)
 * on the page. The other surfaces keep the step the retired graphite ramp had
 * from its own page/card/separator (drawer = page − (5,6,7), band = page + 5,
 * fill = card + (9,9,10), sep / sepSheet = sepChat + (8,9,10) / (14,15,16),
 * switchOff = page + (37,37,38)), so B3's order holds (drawer < page < band <
 * card = sheet < fill). Semantic colours are B3's, untouched. Picked by
 * `themeFor` (`theme-beta.ts`), never by a screen.
 */
const petrol: Palette = {
  ...dark,
  bg: "#151B1D",
  page: "#151B1D",
  card: "#1D2528",
  sheet: "#1D2528",
  drawer: "#101516",
  band: "#1A2022",
  bandOnSheet: "#1D2528",
  fill: "#262E32",
  code: "#1D2528",
  codeOnSheet: "#262E32",
  label: "#D5DDDE",
  sec: "#98A6A8",
  sep: "#2D393D",
  sepChat: "#253033",
  sepSheet: "#333F43",
  tint: "#173136",
  glass: "rgba(29,37,40,0.86)",
  switchOff: "#3A4043",
};

/** The palette for a scheme; an unknown/null scheme is the light one. */
export function paletteFor(scheme: "light" | "dark" | null | undefined): Palette {
  return scheme === "dark" ? dark : light;
}

/**
 * Whether a palette is the dark one — for the few drawing decisions that are
 * about the GROUND rather than a token (a hairline that reads on white and must
 * vanish on black). One comparison, in one place, so a component never re-derives
 * it (`chart-row.ts` does the same for its own chrome).
 */
export const isDark = (palette: Palette): boolean => palette === dark || palette === petrol;

export const lightPalette: Palette = light;
export const darkPalette: Palette = dark;
export const petrolPalette: Palette = petrol;

/**
 * The chart's own tokens (docs/feat/model-charts.md, *iPhone visual language
 * (rev 2)*): the picked mockup's chrome values per mode (`modern-manifest.json`),
 * plus the app's own text colours and the page the chart sits on (no card: the
 * dot rings cut out of `page`). Series colours are core's `CHART_PALETTE`.
 */
export interface ChartTokens {
  readonly guide: string;
  readonly guideStrong: string;
  readonly track: string;
  readonly mutedBar: string;
  readonly mutedLine: string;
  /** Slot 1 at 12 % (light) / 20 % (dark). */
  readonly seriesSoft: string;
  readonly label: string;
  readonly secondary: string;
  readonly surface: string;
  /** The hero pill's rise / fall. */
  readonly up: string;
  readonly down: string;
}

const chartLight = {
  guide: "rgba(60,60,67,0.22)",
  guideStrong: "rgba(60,60,67,0.35)",
  track: "#F0F0F3",
  mutedBar: "#D5D5DA",
  mutedLine: "#AEAEB2",
  seriesSoft: "rgba(7,134,166,0.12)",
} as const;

const chartDark = {
  guide: "rgba(242,241,236,0.16)",
  guideStrong: "rgba(242,241,236,0.28)",
  track: "#2B2B29",
  mutedBar: "#4A4945",
  mutedLine: "#77756F",
  seriesSoft: "rgba(15,160,189,0.2)",
} as const;

/** The chart tokens for the palette's mode. */
export function chartTokensFor(palette: Palette): ChartTokens {
  const chrome = isDark(palette) ? chartDark : chartLight;
  return {
    ...chrome,
    label: palette.label,
    secondary: palette.sec,
    surface: palette.page,
    up: palette.green,
    down: palette.red,
  };
}

/** One iOS text style: size / line height / weight (+ tracking). */
export interface TextStyleToken {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight?: "400" | "500" | "600" | "700";
  readonly letterSpacing?: number;
  readonly fontFamily?: string;
}

/**
 * The mono family: SF Mono, the mockups' `ui-monospace`. RN 0.88 maps the name to
 * `UIFontDescriptorSystemDesignMonospaced` (`RCTFontUtils.mm`); Menlo — wider,
 * heavier — read as oversized code on the owner's iPhone (feedback #3).
 */
export const MONO = "ui-monospace";

export const typography = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700", letterSpacing: 0.37 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: "700" },
  lockTitle: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 22 },
  transcript: { fontSize: 16, lineHeight: 23 },
  bubble: { fontSize: 16, lineHeight: 22 },
  callout: { fontSize: 16, lineHeight: 21 },
  subhead: { fontSize: 15, lineHeight: 20 },
  subheadStrong: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  section: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08 },
  mono: { fontSize: 13, lineHeight: 18, fontFamily: MONO },
  monoCode: { fontSize: 12.5, lineHeight: 19, fontFamily: MONO },
  monoDiff: { fontSize: 12, lineHeight: 21, fontFamily: MONO },
  monoInline: { fontSize: 14, lineHeight: 20, fontFamily: MONO },
  /** A step's name and its one mono line (docs/feat/mobile-tool-rows.md, mockup C). */
  step: { fontSize: 14, lineHeight: 20, fontWeight: "500" },
  stepMono: { fontSize: 12.5, lineHeight: 18, fontFamily: MONO },
  sas: { fontSize: 40, lineHeight: 48, fontWeight: "600", letterSpacing: 6, fontFamily: MONO },
} as const satisfies Record<string, TextStyleToken>;

/** Font-scale cap on dense rows (tool rows, chips, headers); Dynamic Type stays on. */
export const DENSE_FONT_SCALE = 1.4;

export const radius = {
  /** E2: bands are square (docs/feat/mobile-chrome.md Design 1 keeps the token). */
  card: 0,
  /**
   * The centred alert-style dialog (`RenameSheet`), NOT a band: it floats over a
   * scrim at maxWidth 340, so squaring it was an accident of sharing `radius.card`
   * with the bands. Kept at its pre-restyle 26 pt (review round 1).
   */
  dialog: 26,
  /** A sheet's top corners: 38 → 14 (Design 1; the mockups' `14px 14px 0 0`). */
  sheet: 14,
  bubble: 20,
  tile: 14,
  banner: 18,
  queue: 20,
  /**
   * The composer's ONE field (docs/feat/mobile-queued-compose.md D4, Q3): a 22 pt
   * rect holding the input and the 36 pt row under it. Its own token because the
   * field is not a bubble, a card or a sheet, and `size.composer / 2` (24) drew
   * the old glass capsule.
   */
  composer: 22,
  iconTile: 8,
  iconTileLarge: 12,
  pill: 11,
  inlineCode: 5,
} as const;

export const size = {
  touch: 44,
  composer: 48,
  fab: 56,
  rowSession: 64,
  /** An E2 row in a band (Settings, Session info, Computers). */
  rowList: 50,
  rowAction: 52,
  rowSetting: 44,
  bigButton: 50,
  lockButton: 54,
  iconTile: 32,
  iconTileLarge: 44,
  headerList: 52,
  /** The chat header: 56 → 50 (A1's thin row). `headerList` is untouched. */
  headerChat: 50,
  grabberWidth: 36,
  grabberHeight: 5,
  viewfinder: 240,
} as const;

/**
 * The glass shadow: the mockups' `0 6px 20px rgba(0,0,0,0.12)` — a 20 px CSS
 * blur is a 10 pt `shadowRadius`. The opacity is the palette's (`shadowOpacity`).
 */
export const shadow = {
  glass: { shadowColor: "#000000", shadowOffset: { width: 0, height: 6 }, shadowRadius: 10 },
} as const;

export const space = {
  inset: 16,
  /** The E2 band's horizontal inset: label and row content align on it. */
  rowX: 20,
  /** Above a section's small uppercase label (Design 4: 22 pt). */
  sectionTop: 22,
  transcript: 14,
} as const;
