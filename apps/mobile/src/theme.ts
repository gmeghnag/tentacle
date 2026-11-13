/**
 * Colours only (docs/feat/mobile-app-shell.md "Presentation"): the approved
 * mockups' accent, light #0E7490 / dark #06B6D4, and the neutral tones the
 * inset grouped lists use. No logic — the screen picks by `useColorScheme`.
 */

export interface Palette {
  readonly accent: string;
  /** Text on the accent (a filled button). */
  readonly onAccent: string;
  readonly background: string;
  readonly groupedBackground: string;
  readonly card: string;
  readonly separator: string;
  readonly label: string;
  readonly secondaryLabel: string;
  readonly running: string;
  readonly badgeText: string;
  readonly danger: string;
}

const light: Palette = {
  accent: "#0E7490",
  onAccent: "#FFFFFF",
  background: "#F2F2F7",
  groupedBackground: "#F2F2F7",
  card: "#FFFFFF",
  separator: "#C6C6C8",
  label: "#000000",
  secondaryLabel: "#6C6C70",
  running: "#0E7490",
  badgeText: "#FFFFFF",
  danger: "#C1272D",
};

const dark: Palette = {
  accent: "#06B6D4",
  onAccent: "#04252B",
  background: "#000000",
  groupedBackground: "#000000",
  card: "#1C1C1E",
  separator: "#38383A",
  label: "#FFFFFF",
  secondaryLabel: "#8E8E93",
  running: "#06B6D4",
  badgeText: "#04252B",
  danger: "#FF6961",
};

/** The palette for a scheme; an unknown/null scheme is the light one. */
export function paletteFor(scheme: "light" | "dark" | null | undefined): Palette {
  return scheme === "dark" ? dark : light;
}

export const lightPalette: Palette = light;
export const darkPalette: Palette = dark;
