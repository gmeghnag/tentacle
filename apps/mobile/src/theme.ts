/**
 * The design tokens — ONE module, no React, no logic (docs/feat/mobile-ui-polish.md
 * Design 1). Colours are the approved mockups' `renderVals()` tables, light and
 * dark; type, radii, sizes and spacing are the mockups' measures. The screen
 * picks a palette by `useColorScheme`; every primitive takes it as a prop.
 * (The pre-restyle alias names — `groupedBackground`, `secondaryLabel`, … — were
 * removed in Slice 6: every screen now reads the tokens.)
 */

export interface Palette {
  /** Grouped screen background (lists). */
  readonly bg: string;
  /** Chat screen background. */
  readonly page: string;
  readonly card: string;
  readonly sheet: string;
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
  bg: "#000000",
  page: "#000000",
  card: "#1C1C1E",
  sheet: "#1C1C1E",
  fill: "#2C2C2E",
  code: "#1C1C1E",
  codeOnSheet: "#2C2C2E",
  label: "#FFFFFF",
  sec: "#AEAEB2",
  sep: "#38383A",
  sepChat: "#38383A",
  sepSheet: "#48484A",
  accent: "#22D3EE",
  accentFill: "#06B6D4",
  onAccent: "#00191F",
  tint: "#0B2E36",
  green: "#30D158",
  orange: "#FF9F0A",
  red: "#FF6961",
  warnBg: "#3A2A0C",
  warnText: "#FFD08A",
  glass: "rgba(44,44,46,0.82)",
  glassBorder: "rgba(255,255,255,0.12)",
  shadowOpacity: 0.5,
  scrim: "rgba(0,0,0,0.6)",
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
  switchOff: "#39393D",
};

/** The palette for a scheme; an unknown/null scheme is the light one. */
export function paletteFor(scheme: "light" | "dark" | null | undefined): Palette {
  return scheme === "dark" ? dark : light;
}

export const lightPalette: Palette = light;
export const darkPalette: Palette = dark;

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
  sas: { fontSize: 40, lineHeight: 48, fontWeight: "600", letterSpacing: 6, fontFamily: MONO },
} as const satisfies Record<string, TextStyleToken>;

/** Font-scale cap on dense rows (tool rows, chips, headers); Dynamic Type stays on. */
export const DENSE_FONT_SCALE = 1.4;

export const radius = {
  card: 26,
  sheet: 38,
  bubble: 20,
  tile: 14,
  banner: 18,
  queue: 20,
  iconTile: 8,
  iconTileLarge: 12,
  pill: 11,
  inlineCode: 5,
} as const;

export const size = {
  touch: 44,
  composer: 48,
  fab: 56,
  rowProject: 60,
  rowSession: 64,
  rowAction: 52,
  rowSetting: 44,
  bigButton: 50,
  lockButton: 54,
  iconTile: 32,
  iconTileLarge: 44,
  headerList: 52,
  headerChat: 56,
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
  cardInner: 16,
  sectionComputers: 28,
  sectionSessions: 22,
  transcript: 14,
  /** Separator inset after a 32 pt icon tile (16 + 32 + 12). */
  separatorAfterTile: 60,
  separatorPlain: 16,
} as const;
