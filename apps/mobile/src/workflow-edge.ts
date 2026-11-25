/**
 * The RUN view's PAINT (docs/fix/workflows-ux.md D3, slice S6b): how a trace
 * strokes an edge, and how a phase dresses a pill. Pure and React-free (AGENTS
 * §7), so the two rules the owner decided are a TABLE with a test instead of a
 * ternary inside a component:
 *
 * - **a taken edge is SOLID — `goto` and `retry` included** (owner, after Q5).
 *   The mockup dashed them by kind; that would say "possible" about an edge that
 *   already happened. Kind now decides nothing about the stroke.
 * - **`later` is dashed and dimmed, `never` dotted and dimmed, `go` the accent
 *   with the flowing dash** (animated until Reduce Motion stills it).
 *
 * The pill's chrome follows the same table idea: a running pill is ringed in the
 * accent, one that waits on the person in the label colour, `not yet` a dashed
 * outline with no body, `not run` a dotted one — three shapes, no hue alone.
 *
 * Numbers are the mockup's own (`final-v3.html`: `--wr-edge` 1.5, `--wr-dash`
 * `5 4`, `--wr-dot` `1 4`, `--wr-dim` 0.55).
 */
import type { WorkflowPhase, WorkflowTrace } from "@tentacle/client";
import type { Palette } from "./theme.ts";

/** One edge weight for both graphs (the editor's `--wf-edge` and the run's agree). */
export const EDGE_WIDTH = 1.5;
/** A possible-but-not-taken edge: the mockup's `--wr-dash`. */
export const EDGE_DASH = "5 4";
/** An edge that cannot happen any more: the mockup's `--wr-dot` (barely a line). */
export const EDGE_DOT = "1 4";
/** Not-run / not-taken ink. Above the kit's 0.3 low-dot, so the word stays legible. */
export const EDGE_DIM = 0.55;

/** How one edge is stroked. `animate` = the flowing dash (a live run's current leg). */
export interface EdgeLook {
  readonly stroke: string;
  /** `undefined` = a solid line (a taken edge, goto and retry included). */
  readonly dashArray?: string;
  readonly opacity: number;
  readonly width: number;
  readonly animate: boolean;
}

/**
 * The stroke for a projected edge. The KIND is deliberately ignored: the owner's
 * rule is that what happened is solid whatever kind of edge it was, and the trace
 * alone says whether it happened.
 */
export function edgeLook(trace: WorkflowTrace, palette: Palette): EdgeLook {
  switch (trace) {
    case "taken":
      return { stroke: palette.label, opacity: 1, width: EDGE_WIDTH, animate: false };
    case "go":
      return {
        stroke: palette.accent,
        dashArray: EDGE_DASH,
        opacity: 1,
        width: EDGE_WIDTH,
        animate: true,
      };
    case "later":
      return {
        stroke: palette.sec,
        dashArray: EDGE_DASH,
        opacity: EDGE_DIM,
        width: EDGE_WIDTH,
        animate: false,
      };
    default:
      return {
        stroke: palette.sec,
        dashArray: EDGE_DOT,
        opacity: EDGE_DIM,
        width: EDGE_WIDTH,
        animate: false,
      };
  }
}

/**
 * How one pill is dressed. Palette-free on purpose (the component maps `body` and
 * `ring` to the theme's own colours): the DECISION is which of the three shapes a
 * phase gets, and that is what the test pins.
 */
export interface PillLook {
  /** A solid body, or none at all (the outline alone says "nothing here"). */
  readonly body: boolean;
  readonly ring: "solid" | "dashed" | "dotted";
  readonly ringWidth: number;
  /** The hairline is the resting pill; a live or waiting one is ringed thicker. */
  readonly emphatic: boolean;
  /** Text and marker at `EDGE_DIM`: a step that did not happen is quieter. */
  readonly dim: boolean;
}

/** The resting pill: a card body in a hairline. */
const RESTING: PillLook = {
  body: true,
  ring: "solid",
  ringWidth: 1,
  emphatic: false,
  dim: false,
};

export function pillLook(phase: WorkflowPhase): PillLook {
  switch (phase) {
    case "running":
      return { ...RESTING, ringWidth: 2, emphatic: true };
    case "ask":
      return { ...RESTING, ringWidth: 2, emphatic: true };
    case "later":
      // Not yet: no body, a dashed outline — it will happen, it has not started.
      return { body: false, ring: "dashed", ringWidth: 1, emphatic: false, dim: true };
    case "skipped":
      // Not run: no body, a dotted outline — the owner's "there is nothing here".
      return { body: false, ring: "dotted", ringWidth: EDGE_WIDTH, emphatic: false, dim: true };
    default:
      return RESTING;
  }
}
