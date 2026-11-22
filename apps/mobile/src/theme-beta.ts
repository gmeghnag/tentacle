/**
 * The Figtree try-out theme (docs/feat/mobile-theme-beta.md): Settings → Beta →
 * "Tema Figtree (prova)", OFF by default.
 *
 * Pure and React-free (AGENTS §7): which palette and which font a switch + a
 * colour scheme give, and how one text's own style becomes a Figtree face. `App.tsx`
 * asks `themeFor` once per render; `ui/Text.tsx` asks `textFont` per text. OFF is
 * today's look by construction: the same palette objects, and no font patch.
 */
import { type Palette, lightPalette, paletteFor, petrolPalette } from "./theme.ts";

/** The theme's Beta switch, remembered per device (`theme-settings-store.ts`). */
export interface ThemeBeta {
  readonly figtree: boolean;
}

export const DEFAULT_THEME_BETA: ThemeBeta = { figtree: false };

/** The app font: `null` is the system font (today). */
export type AppFont = "figtree" | null;

export interface Theme {
  readonly palette: Palette;
  readonly font: AppFont;
}

/**
 * The theme for a scheme + the switch. ON: dark moves to petrol, light keeps
 * its palette (only the font changes). The font waits for `fontReady` — the
 * faces registered — so a text never asks iOS for a family it does not have.
 */
export function themeFor(
  scheme: "light" | "dark" | null | undefined,
  beta: ThemeBeta,
  fontReady: boolean,
): Theme {
  if (!beta.figtree) return { palette: paletteFor(scheme), font: null };
  return {
    palette: scheme === "dark" ? petrolPalette : lightPalette,
    font: fontReady ? "figtree" : null,
  };
}

/**
 * What a render cached per palette must add to its key: today's palettes add
 * nothing (every stored key stays valid), petrol adds its name — a diagram
 * drawn on today's dark page must not be shown on petrol's.
 */
export function paletteVariant(palette: Palette): "petrol" | undefined {
  return palette === petrolPalette ? "petrol" : undefined;
}

/**
 * The eight bundled faces (`assets/fonts`, SIL OFL 1.1): one per (weight, style)
 * the app can ask (docs/fix/mobile-transcript-type.md — a weight no face carries
 * is rounded away, so 500 and 600 have to exist as files). Each key is the face's
 * PostScript name, which is also the name `fonts-expo.ts` registers it under.
 */
export const FIGTREE_FACES = {
  regular: "Figtree-Regular",
  medium: "Figtree-Medium",
  semiBold: "Figtree-SemiBold",
  bold: "Figtree-Bold",
  italic: "Figtree-Italic",
  mediumItalic: "Figtree-MediumItalic",
  semiBoldItalic: "Figtree-SemiBoldItalic",
  boldItalic: "Figtree-BoldItalic",
} as const;

export type FigtreeFace = (typeof FIGTREE_FACES)[keyof typeof FIGTREE_FACES];

/** Each face's own `usWeightClass` (read from its `OS/2` table): the weight to name it with. */
const FACE_WEIGHT: Readonly<Record<FigtreeFace, "400" | "500" | "600" | "700">> = {
  [FIGTREE_FACES.regular]: "400",
  [FIGTREE_FACES.medium]: "500",
  [FIGTREE_FACES.semiBold]: "600",
  [FIGTREE_FACES.bold]: "700",
  [FIGTREE_FACES.italic]: "400",
  [FIGTREE_FACES.mediumItalic]: "500",
  [FIGTREE_FACES.semiBoldItalic]: "600",
  [FIGTREE_FACES.boldItalic]: "700",
};

type Weight = string | number | undefined;
type FontStyleValue = string | undefined;

/** The weights a name stands for (CSS keyword names; numbers pass through). */
const WEIGHT_NAMES: Readonly<Record<string, number>> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  heavy: 800,
  black: 900,
};

/** A weight as a number, or 400 when it says nothing usable (RN's own default). */
function weightOf(weight: Weight): number {
  if (weight === undefined) return 400;
  if (typeof weight === "number") return Number.isFinite(weight) ? weight : 400;
  const named = WEIGHT_NAMES[weight.trim().toLowerCase()];
  if (named !== undefined) return named;
  const n = Number(weight);
  return Number.isFinite(n) ? n : 400;
}

/**
 * The face for a weight and a style, EXACT for the weights the app asks
 * (400/500/600/700), the nearest BOLD for anything above 700 and the nearest
 * face for anything below 400 — never `undefined`, so a text never falls back to
 * the system font.
 */
export function figtreeFace(weight: Weight, style: FontStyleValue): FigtreeFace {
  const italic = style === "italic";
  const w = weightOf(weight);
  if (w >= 700) return italic ? FIGTREE_FACES.boldItalic : FIGTREE_FACES.bold;
  if (w >= 600) return italic ? FIGTREE_FACES.semiBoldItalic : FIGTREE_FACES.semiBold;
  if (w >= 500) return italic ? FIGTREE_FACES.mediumItalic : FIGTREE_FACES.medium;
  return italic ? FIGTREE_FACES.italic : FIGTREE_FACES.regular;
}

/** The font-relevant part of a text's own (flattened) style. */
export interface OwnFont {
  readonly fontFamily?: string | undefined;
  readonly fontWeight?: Weight;
  readonly fontStyle?: FontStyleValue;
}

/** What a text passes to the texts nested in it (RN's own inheritance, mirrored). */
export interface FontInherit {
  readonly family?: string | undefined;
  readonly weight?: Weight;
  readonly style?: FontStyleValue;
}

/**
 * The style a Figtree text gets on top of its own. The weight and the style are the
 * FACE's own (400/500/600/700, normal/italic) so iOS's own family matching lands on
 * the very face it was named — a weight left to RN's matcher is what lost 500.
 */
export interface FigtreePatch {
  readonly fontFamily: FigtreeFace;
  readonly fontWeight: "400" | "500" | "600" | "700";
  readonly fontStyle: "normal" | "italic";
}

/**
 * One text's Figtree patch, from its own style and what its parent text gave it.
 * `null` patch: the font is off, or the text (or a parent) names its own family
 * (monospace code stays monospace).
 */
export function textFont(
  own: OwnFont,
  inherited: FontInherit,
  font: AppFont,
): { readonly patch: FigtreePatch | null; readonly inherit: FontInherit } {
  const inherit: FontInherit = {
    family: own.fontFamily ?? inherited.family,
    weight: own.fontWeight ?? inherited.weight,
    style: own.fontStyle ?? inherited.style,
  };
  if (font === null || inherit.family !== undefined) return { patch: null, inherit };
  const face = figtreeFace(inherit.weight, inherit.style);
  const italic =
    face === FIGTREE_FACES.italic ||
    face === FIGTREE_FACES.mediumItalic ||
    face === FIGTREE_FACES.semiBoldItalic ||
    face === FIGTREE_FACES.boldItalic;
  return {
    patch: {
      fontFamily: face,
      // The FACE's own weight class (`FIGTREE_FACE_WEIGHTS`), so iOS matches it.
      fontWeight: FACE_WEIGHT[face],
      fontStyle: italic ? "italic" : "normal",
    },
    inherit,
  };
}
