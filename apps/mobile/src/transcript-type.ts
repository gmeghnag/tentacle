/**
 * docs/fix/mobile-transcript-type.md (owner decisions 2-3): the weight a
 * transcript's PROSE is drawn at, and the step row's own type. Pure and
 * React-free (AGENTS §7): `Markdown.tsx` and `StepNode.tsx` stay dumb renderers.
 *
 * Why a function and not a token: the answer depends on the GROUND. Dark-on-light
 * already reads heavy at 400, so the light theme keeps 400; a dark page (today's
 * dark and the Beta petrol one — `isDark` is the app's one predicate) gets 500,
 * Figtree Medium, which is the whole point of bundling it.
 */
import { type Palette, isDark, typography } from "./theme.ts";

/** The weight transcript prose is drawn at on this palette: 500 on a dark ground, else 400. */
export function proseFontWeight(palette: Palette): "400" | "500" {
  return isDark(palette) ? "500" : "400";
}

/**
 * The paragraph/list style for a palette: `typography.transcript`'s size and line
 * height (16/23, untouched — owner decision 4) with the ground's weight.
 */
export function proseStyle(palette: Palette): {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500";
} {
  return { ...typography.transcript, fontWeight: proseFontWeight(palette) };
}
