/**
 * The workflow graphs' SHARED METRICS — and nothing else any more (docs/fix/
 * workflows-ux.md S6b).
 *
 * The run's graph used to be GEOMETRY here too (`graphGeometry`, `nodeAt`,
 * `nodeSubtitle`, `graphHeader`), and it was the defect: it placed pills in FILE
 * order and read the loop off `maxRound`, so a `goto` target that was never
 * entered sat inside the linear chain and there was no back edge at all. The run
 * is drawn from the run's own definition now — `workflow-run-layout.ts`, over the
 * shared projection — so that guess is deleted rather than left to be called by
 * mistake.
 *
 * What stays is what the EDITOR (`workflow-edit-graph.ts`) imports: its graph is a
 * DRAFT, not a run, so it has no projection and legitimately keeps its own
 * placement — but the two graphs must scale into the same logical width and use
 * the same pill and pitch, or switching between them would jump.
 */
import { size } from "./theme.ts";

/** The mockup's logical width: the drawing is authored once here and scaled by the renderer. */
export const GRAPH_WIDTH = 318;

/** A pill is one touch target tall and fully rounded — the mockup's 44 px / 22 px radius. */
export const PILL_H = size.touch;
export const PILL_RADIUS = PILL_H / 2;

/** Vertical pitch: the pill plus `NODE_GAP`, the mockup's 70 px. */
export const NODE_GAP = 26;
export const PITCH = PILL_H + NODE_GAP;

/** Top inset of the first pill, so its halo has room above it. */
export const TOP_PAD = 14;

/** The state badge on a pill: the mockup's 26 pt disc, inset by half the difference. */
export const BADGE = 26;
export const BADGE_INSET = (PILL_H - BADGE) / 2;

/** Bottom room: the last pill's drop shadow and the loop's label. */
export const BOTTOM_PAD = 34;

/**
 * The three column shapes. A step in the straight flow is the wide main pill; a
 * loop's SOURCE is the narrow left one and its TARGET the narrow right one, so the
 * dashed back edge has somewhere to go (the mockup's x 64/6/172, w 190/150/140).
 */
export const MAIN = { x: 64, w: 190 } as const;
export const LOOP_SOURCE = { x: 6, w: 150 } as const;
export const LOOP_TARGET = { x: 172, w: 140 } as const;

/** The dashed back edge's bow: the gap between the loop's two narrow columns. */
export const LOOP_BOW = 26;

/** The mockup's smooth vertical connector: down out of `(x1,y1)` and into `(x2,y2)`. */
export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}
