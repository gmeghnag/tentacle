/**
 * Where the composer sits at the bottom of the chat (B1): ONE place for the rule,
 * pure and unit-tested (AGENTS §7); `SessionScreen.tsx` only applies it.
 *
 * Keyboard closed → clear the home indicator (the safe-area bottom inset, 34 pt
 * on a Face ID iPhone). Keyboard open → the keyboard already covers that area, so
 * only the minimum gap. A device with no indicator (SE) keeps the old 8 pt.
 */

/** The composer's own bottom gap, the value it had before the safe area. */
export const COMPOSER_MIN_PADDING = 8;

export function composerBottomPadding(input: {
  readonly insetBottom: number;
  readonly keyboard: boolean;
}): number {
  return input.keyboard ? COMPOSER_MIN_PADDING : Math.max(input.insetBottom, COMPOSER_MIN_PADDING);
}
