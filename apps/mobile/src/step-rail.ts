/**
 * The step rail's geometry (docs/fix/mobile-step-rail.md, owner decision 3): the
 * gutter the rail runs in, where the node sits on it, and the branch that leaves
 * the rail and curves onto a step's `$ command` line. Pure and React-free
 * (AGENTS §7), so the shape is testable without a renderer:
 * `ui/StepNode.tsx` maps it onto a View's absolute box and owns only the look.
 *
 * Why the branch is computed and not a constant (review round 1, finding 2): the
 * text grows with Dynamic Type up to `DENSE_FONT_SCALE`, a hard-coded box did not
 * — at the big sizes the border box fell to 3 pt, with no room even for the
 * turn's own radius, so the "curved branch" read as a tick. Here it runs from
 * the node's centre (its vertical stroke lies ON the rail, and the node, drawn
 * above it, hides its first points) down to exactly where the `$` line's middle
 * lands at the type's scale — never short of it, never past it.
 */
import { DENSE_FONT_SCALE, size, typography } from "./theme.ts";

/** The rail's own column: 10 pt wide, the line down its middle. */
export const GUTTER = 10;
/** The node sits on the first line's centre; the line is one touch target tall. */
export const NODE_Y = size.touch / 2;
/**
 * The turn's radius. Smaller than the shortest branch (10 pt, at the default
 * type), so the curve always has room; it does not need to grow with the type.
 */
export const BRANCH_TURN = 6;

/** How far the branch runs across, from the rail into the text column. */
export const BRANCH_REACH = GUTTER / 2 + 4;

/**
 * The branch's box in the gutter at `fontScale` (React Native's
 * `useWindowDimensions`, capped where the step's own texts are — they are drawn
 * at `min(fontScale, DENSE_FONT_SCALE)`): `top` from the row's top,
 * `height` down to the `$` line's middle. The radius is `BRANCH_TURN`, always.
 */
export function branchGeometry(fontScale: number): {
  readonly top: number;
  readonly height: number;
} {
  // Capped like the texts (`maxFontSizeMultiplier`); a smaller type (iOS xSmall,
  // 0.82) shrinks them too, so it is followed as it is, not floored.
  const scale = Math.min(fontScale, DENSE_FONT_SCALE);
  const title = typography.step.lineHeight * scale;
  const mono = typography.stepMono.lineHeight * scale;
  // The stacked line centres its two text rows in one touch target (the title
  // row, then the `$` row): half the mono row below the title is its middle.
  const sublineMid = Math.max(0, (size.touch - title - mono) / 2) + title + mono / 2;
  return { top: NODE_Y, height: sublineMid - NODE_Y };
}
