/**
 * docs/fix/workflows-ux.md S6b — the run view's PAINT (`workflow-edge.ts`): what
 * stroke a trace gets and what chrome a phase gets. Pure, so the owner's two rules
 * are a table with a test rather than a ternary buried in the renderer:
 *
 * - a TAKEN edge is SOLID, `goto` and `retry` included (the owner overrode the
 *   mockup's dashed-by-kind goto/retry: an edge that already happened is not
 *   "possible");
 * - `later` is dashed and dimmed, `never` dotted and dimmed, `go` the accent with
 *   the flowing dash — and the flow is the ONLY thing that says "now", so it is the
 *   thing Reduce Motion must be able to still.
 */
import { describe, expect, test } from "bun:test";
import { darkPalette, lightPalette } from "../src/theme.ts";
import {
  EDGE_DASH,
  EDGE_DIM,
  EDGE_DOT,
  EDGE_WIDTH,
  edgeLook,
  pillLook,
} from "../src/workflow-edge.ts";

describe("an edge's stroke says what happened, never what kind of edge it is", () => {
  test("a taken edge is SOLID: no dash, full opacity, the label's ink", () => {
    const look = edgeLook("taken", lightPalette);
    expect(look.dashArray).toBeUndefined();
    expect(look.opacity).toBe(1);
    expect(look.width).toBe(EDGE_WIDTH);
    expect(look.animate).toBe(false);
    expect(look.stroke).toBe(lightPalette.label);
  });

  test("mutation check: the kind cannot resurface a dash — a taken edge has no dashArray", () => {
    // The mockup dashes `goto`/`retry` by kind. `edgeLook` takes the TRACE only, so
    // there is no argument that could bring the dash back for a taken goto.
    expect(edgeLook("taken", darkPalette).dashArray).toBeUndefined();
    expect(edgeLook.length).toBe(2);
  });

  test("`go` is the accent, dashed, and the only animated trace", () => {
    const look = edgeLook("go", lightPalette);
    expect(look.stroke).toBe(lightPalette.accent);
    expect(look.dashArray).toBe(EDGE_DASH);
    expect(look.animate).toBe(true);
    for (const trace of ["taken", "later", "never"] as const) {
      expect(edgeLook(trace, lightPalette).animate).toBe(false);
    }
  });

  test("`later` is dashed and dimmed, `never` dotted and dimmed — different shapes, same dim", () => {
    const later = edgeLook("later", lightPalette);
    const never = edgeLook("never", lightPalette);
    expect(later.dashArray).toBe(EDGE_DASH);
    expect(never.dashArray).toBe(EDGE_DOT);
    expect(later.dashArray).not.toBe(never.dashArray);
    expect(later.opacity).toBe(EDGE_DIM);
    expect(never.opacity).toBe(EDGE_DIM);
    expect(later.stroke).toBe(lightPalette.sec);
  });

  test("NO trace is invisible: every one carries an ink and a weight", () => {
    for (const palette of [lightPalette, darkPalette]) {
      for (const trace of ["taken", "go", "later", "never"] as const) {
        const look = edgeLook(trace, palette);
        expect(look.stroke.length).toBeGreaterThan(0);
        expect(look.width).toBeGreaterThan(0);
      }
    }
  });
});

describe("a pill's chrome: three shapes, no hue alone", () => {
  test("running and ask are RINGED thicker (a live pill and one waiting on the person)", () => {
    for (const phase of ["running", "ask"] as const) {
      const look = pillLook(phase);
      expect(look.emphatic).toBe(true);
      expect(look.ringWidth).toBeGreaterThan(pillLook("ok").ringWidth);
      expect(look.body).toBe(true);
    }
  });

  test("`not yet` is a dashed outline with no body; `not run` a dotted one", () => {
    const later = pillLook("later");
    expect(later.body).toBe(false);
    expect(later.ring).toBe("dashed");
    expect(later.dim).toBe(true);
    const skipped = pillLook("skipped");
    expect(skipped.body).toBe(false);
    expect(skipped.ring).toBe("dotted");
    expect(skipped.dim).toBe(true);
    // The two "did not happen" shapes must not look alike: one says "will", one "won't".
    expect(later.ring).not.toBe(skipped.ring);
  });

  test("a step that happened is a plain card body — never dimmed", () => {
    for (const phase of ["ok", "error", "stopped", "unknown"] as const) {
      const look = pillLook(phase);
      expect(look.body).toBe(true);
      expect(look.dim).toBe(false);
      expect(look.ring).toBe("solid");
    }
  });
});
