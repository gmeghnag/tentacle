/**
 * The node → detail **morph** as numbers (docs/feat/agent-workflows.md slice 8;
 * spec `docs/feat/agent-workflows/transition.html` variant A, the owner's choice).
 * Pure and React-free (AGENTS §7): `screens/WorkflowStep.tsx` feeds these to
 * React Native's `Animated`, exactly as `step-rail.ts` feeds the rail's curve, so
 * the choreography is tested with no renderer, no timers and no simulator.
 *
 * The property the whole transition stands on is ONE sentence: **every inner part
 * of the pill grows with the pill.** A ghost that only animated its box would land
 * as a different object — the badge, the glyph, the title and the subtitle would
 * snap to their detail sizes on the last frame. So every property a frame carries
 * is interpolated from the SAME `progress` value, and `morphFrame` is a pure
 * function of it: no part is ever "already final" while the box is still flying.
 *
 * Reduce Motion is not a slower morph: it is a crossfade (`morphLook`), the
 * owner's rule, and the skeleton is then static (no shimmer) rather than absent.
 *
 * Timings are the mockup's own (380 ms flight, 60→380 ms of stagger), hoisted to
 * constants so a test can assert the mapping from progress to property without
 * pinning a number in two places.
 */
import { size } from "./theme.ts";

/** A pill's outer box and the parts inside it, in points. */
export interface PillMetrics {
  readonly height: number;
  readonly radius: number;
  readonly padLeft: number;
  readonly padRight: number;
  readonly gap: number;
  readonly badge: number;
  readonly glyphSize: number;
  readonly titleSize: number;
  readonly subtitleSize: number;
}

/**
 * The graph node's metrics — the pill at rest inside the 2C canvas
 * (`workflow-graph.ts`'s 44 pt pill, its 26 pt badge). Authored here rather than
 * imported so a change to the graph's own box cannot silently deform the detail's
 * header: the two are separate surfaces that happen to agree today, and the
 * agreement is asserted by a test instead of assumed by `import`.
 */
export const NODE_METRICS: PillMetrics = {
  height: size.touch,
  radius: size.touch / 2,
  padLeft: 8,
  padRight: 12,
  gap: 10,
  badge: 26,
  glyphSize: 13,
  titleSize: 13.5,
  subtitleSize: 11,
};

/**
 * The detail header's metrics — the same pill, grown (`transition.html`'s
 * `BIG`: 38 pt badge, 17 pt glyph/title, 13 pt subtitle, 12 pt padding). Its
 * height is the detail's own hero box, not a scaled pill: the header is where the
 * pill LANDS, so its size is the target of the morph, not a multiple of it.
 */
export const HERO_METRICS: PillMetrics = {
  height: 68,
  radius: 32,
  padLeft: 12,
  padRight: 16,
  gap: 12,
  badge: 38,
  glyphSize: 17,
  titleSize: 17,
  subtitleSize: 13,
};

/** The mockup's flight and its easing (`cubic-bezier(.2,.8,.2,1)`): out fast, in soft. */
export const MORPH_FLIGHT_MS = 380;
export const MORPH_CLOSE_MS = 340;
/** The detail rows fade in behind the flying pill, from 120 ms in, `ROW_STAGGER_MS` apart. */
export const ROW_STAGGER_MS = 45;
export const ROW_FIRST_DELAY_MS = 120;
export const ROW_FADE_MS = 260;
/** Reduce Motion: one crossfade, both ways (the mockup's 180 ms). */
export const CROSSFADE_MS = 180;
/** How long the graph's own layer takes to fade behind the flying pill. */
export const GRAPH_FADE_OUT_MS = 260;
/** The four easing points, as the mockup writes them. */
export const MORPH_EASING = { x1: 0.2, y1: 0.8, x2: 0.2, y2: 1 } as const;

/**
 * A cubic-bezier timing curve evaluated at `t ∈ [0,1]`. React Native's `Animated`
 * has `Easing.bezier`, but the *geometry* must not depend on the animation driver:
 * a test has to ask "what does the frame look like at 0.37" without mounting one.
 * Newton's method, as CSS's own solver: 8 steps is well inside a frame's budget.
 */
export function bezier(t: number, ease: typeof MORPH_EASING = MORPH_EASING): number {
  const clamp = Math.min(1, Math.max(0, t));
  const cx = 3 * ease.x1;
  const bx = 3 * (ease.x2 - ease.x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * ease.y1;
  const by = 3 * (ease.y2 - ease.y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number): number => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;

  let u = clamp;
  for (let i = 0; i < 8; i += 1) {
    const dx = sampleX(u) - clamp;
    if (Math.abs(dx) < 1e-6) {
      break;
    }
    const slope = slopeX(u);
    if (Math.abs(slope) < 1e-6) {
      break;
    }
    u -= dx / slope;
  }
  return sampleY(Math.min(1, Math.max(0, u)));
}

/** One box in the logical space the morph works in (screen points here, not the graph's 318). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One interpolated frame: the flying pill's box, and every part inside it. */
export interface MorphFrame {
  readonly box: Box;
  readonly radius: number;
  readonly padLeft: number;
  readonly padRight: number;
  readonly gap: number;
  readonly badge: number;
  readonly glyphSize: number;
  readonly titleSize: number;
  readonly subtitleSize: number;
}

/** Linear interpolation of one number (`progress` is already eased by the caller). */
function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * The frame at eased progress `t`: every property mixed between the node's metrics
 * and the hero's, from the SAME `t`. That is the invariant — a test walks 0..1 in
 * small steps and asserts each part is monotone AND that no part reaches its final
 * value before `t = 1` (which is what "nothing snaps" means, precisely).
 *
 * The detail's ROWS are not part of the frame: they run on their own clock and
 * outlast the flight (the mockup fades them from 120 ms for 260 ms, past the
 * 380 ms pill), because a stagger that had to finish inside the flight would be a
 * few milliseconds apart and read as a single flash. `rowStartMs`/`rowOpacityAt`
 * are that clock.
 */
export function morphFrame(
  t: number,
  from: Box,
  to: Box,
  fromMetrics: PillMetrics = NODE_METRICS,
  toMetrics: PillMetrics = HERO_METRICS,
): MorphFrame {
  // A NaN progress (an interrupted animation driver can produce one) would put
  // NaN into every box of the layout: the frame falls back to its START, which is
  // the one state that is always safe to draw — the pill, in the graph's place.
  const eased = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return {
    box: {
      x: mix(from.x, to.x, eased),
      y: mix(from.y, to.y, eased),
      width: mix(from.width, to.width, eased),
      height: mix(from.height, to.height, eased),
    },
    radius: mix(fromMetrics.radius, toMetrics.radius, eased),
    padLeft: mix(fromMetrics.padLeft, toMetrics.padLeft, eased),
    padRight: mix(fromMetrics.padRight, toMetrics.padRight, eased),
    gap: mix(fromMetrics.gap, toMetrics.gap, eased),
    badge: mix(fromMetrics.badge, toMetrics.badge, eased),
    glyphSize: mix(fromMetrics.glyphSize, toMetrics.glyphSize, eased),
    titleSize: mix(fromMetrics.titleSize, toMetrics.titleSize, eased),
    subtitleSize: mix(fromMetrics.subtitleSize, toMetrics.subtitleSize, eased),
  };
}

/** What the transition DOES on this device: the morph, or (Reduce Motion) a crossfade. */
export type MorphLook =
  | { readonly kind: "morph"; readonly flightMs: number; readonly closeMs: number }
  | { readonly kind: "crossfade"; readonly ms: number };

/**
 * Reduce Motion picks the crossfade (owner's rule, and the mockup's "Riduci
 * movimento" switch). A crossfade has no flight, so the pill never moves: the
 * detail simply appears where it belongs, and the skeleton underneath is static.
 */
export function morphLook(reduceMotion: boolean): MorphLook {
  return reduceMotion
    ? { kind: "crossfade", ms: CROSSFADE_MS }
    : { kind: "morph", flightMs: MORPH_FLIGHT_MS, closeMs: MORPH_CLOSE_MS };
}

/**
 * Whether the graph's own layer is still visibly present, `progress` of the way
 * through the flight. The mockup fades the graph out over its first 260 ms of 380
 * (`opacity 1→0`, `scale 1→.97`) while the ghost flies: keeping it fully drawn
 * would show the pill twice — once in place, once in the air.
 */
export function graphLayerOpacity(progress: number): number {
  return 1 - graphFadeAmount(progress);
}

/** The graph's own scale: the 3 % "step back" that separates the two layers. */
export function graphLayerScale(progress: number): number {
  return mix(1, 0.97, graphFadeAmount(progress));
}

/** How far the graph's layer has faded, 0..1, from the flight's own progress. */
function graphFadeAmount(progress: number): number {
  const at = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  // The fade ENDS at `GRAPH_FADE_OUT_MS`, well before the pill lands, and holds at
  // 1 thereafter: a layer still dissolving under the landed header would read as a
  // flicker at the very moment the person is trying to read it.
  return Math.min(1, (at * MORPH_FLIGHT_MS) / GRAPH_FADE_OUT_MS);
}

/** One detail row's fade-in START, in ms from the transition's beginning (the mockup's stagger). */
export function rowStartMs(index: number): number {
  return ROW_FIRST_DELAY_MS + Math.max(0, index) * ROW_STAGGER_MS;
}

/**
 * One row's opacity, `ms` after the transition began. The rows outlast the pill on
 * purpose (a stagger that had to fit inside the flight would be 3 ms apart and read
 * as one flash), so this takes milliseconds, not the flight's 0..1 progress.
 */
export function rowOpacityAt(ms: number, index: number): number {
  const start = rowStartMs(index);
  const elapsed = (Number.isFinite(ms) ? ms : 0) - start;
  return Math.min(1, Math.max(0, elapsed / ROW_FADE_MS));
}

/** When the whole block has finished fading in: the last row's start plus its fade. */
export function rowsSettledMs(count: number): number {
  return count <= 0 ? 0 : rowStartMs(count - 1) + ROW_FADE_MS;
}
