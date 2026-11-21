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
 * The four bundled faces (`assets/fonts`, SIL OFL 1.1). Each key is the face's
 * PostScript name, which is also the name `fonts-expo.ts` registers it under.
 */
export const FIGTREE_FACES = {
  regular: "Figtree-Regular",
  bold: "Figtree-Bold",
  italic: "Figtree-Italic",
  boldItalic: "Figtree-BoldItalic",
} as const;

export type FigtreeFace = (typeof FIGTREE_FACES)[keyof typeof FIGTREE_FACES];

type Weight = string | number | undefined;
type FontStyleValue = string | undefined;

const BOLD_NAMES = new Set(["bold", "semibold", "heavy", "black"]);

/** Bold from 600 up (and the bold names); 500 and below is Regular. */
function isBold(weight: Weight): boolean {
  if (weight === undefined) return false;
  if (typeof weight === "number") return weight >= 600;
  if (BOLD_NAMES.has(weight)) return true;
  const n = Number(weight);
  return Number.isFinite(n) && n >= 600;
}

export function figtreeFace(weight: Weight, style: FontStyleValue): FigtreeFace {
  const bold = isBold(weight);
  const italic = style === "italic";
  if (bold) return italic ? FIGTREE_FACES.boldItalic : FIGTREE_FACES.bold;
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
 * FACE's (400/700, normal/italic) so iOS's own family matching lands on the same
 * face it was named (a 500 left as 500 would round to Bold).
 */
export interface FigtreePatch {
  readonly fontFamily: FigtreeFace;
  readonly fontWeight: "400" | "700";
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
  const bold = face === FIGTREE_FACES.bold || face === FIGTREE_FACES.boldItalic;
  const italic = face === FIGTREE_FACES.italic || face === FIGTREE_FACES.boldItalic;
  return {
    patch: {
      fontFamily: face,
      fontWeight: bold ? "700" : "400",
      fontStyle: italic ? "italic" : "normal",
    },
    inherit,
  };
}
