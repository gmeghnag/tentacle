/**
 * The detail layer's wiring (docs/feat/workflows-ui.md D5, slice 4), pinned from
 * the source — `.tsx` is unimportable from Bun (React Native's sources are Flow),
 * the `workflow-screens-wiring.test.ts` pattern. What the layer COMPUTES comes from
 * `workflow-step-layer.test.ts` / `workflow-morph-table.test.ts`; what it DRAWS is
 * checked here: the layer is inside the run screen (never a navigation push), it is
 * driven by ONE progress value and ONE flight, it reads Reduce Motion, and a tap
 * while a flight runs is ignored.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const LAYER = code(read("src", "screens", "WorkflowStep.tsx"));
const RUN = code(read("src", "screens", "WorkflowRun.tsx"));
const APP = code(read("App.tsx"));

const between = (src: string, from: string, to: string): string => {
  const at = src.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf(to, at + from.length);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
};

describe("the detail is a LAYER inside the run screen, never a navigation push", () => {
  test("the run screen mounts it, and App.tsx adds no route for it", () => {
    expect(RUN).toContain("<WorkflowStepLayer");
    expect(APP).not.toContain('name="WorkflowStep"');
  });

  test("no <Modal> and no native-stack push: the graph underneath stays mounted", () => {
    expect(LAYER).not.toContain("<Modal");
    expect(LAYER).not.toContain("navigate(");
    // The graph screen is the layer's sibling, not its parent's replacement.
    expect(RUN).toContain("<Graph");
    // The guard grew one term in S6b (the projection, which the flight starts from):
    // the layer still mounts BESIDE the graph, never instead of it.
    expect(RUN).toContain(
      "{openCard === undefined || run === null || projection === null ? null : (",
    );
  });
});

describe("the flight: ONE progress value, from the pure module's TABLE", () => {
  const body = between(LAYER, "export function WorkflowStepLayer", "\n}");

  test("every animated property is an interpolation of the SAME `morphTable`", () => {
    // One source of the motion (`workflow-morph.ts`): the component holds a progress
    // value and maps the table onto it — it never computes an easing of its own.
    expect(body).toContain("morphTable(pair.from, pair.to)");
    expect(body).toContain("table?.inputRange");
    // EVERY part the flight moves reads its output from the table: a literal here is
    // a part that snaps (the mockup's whole point, `morphFrame`'s own test).
    for (const part of [
      "table.box.x",
      "table.box.y",
      "table.box.width",
      "table.box.height",
      "table.radius",
      "table.padLeft",
      "table.padRight",
      "table.gap",
      "table.badge",
      "table.glyphSize",
      "table.titleSize",
      "table.subtitleSize",
    ]) {
      expect({ part, read: body.includes(`interp(${part})`) }).toEqual({ part, read: true });
    }
    // No second animation curve: the easing comes from the module's constant.
    expect(body).toContain("FLIGHT_EASING");
    expect(body).not.toContain("Animated.spring");
    expect(body).not.toContain("bezier(");
  });

  test("the JS driver, because these are LAYOUT props (the native driver refuses them)", () => {
    expect(body).toContain("useNativeDriver: false");
  });

  test("one flight at a time: a tap while it runs is ignored", () => {
    // `flightBusy` is set on start and cleared only on the animation's completion,
    // so a second tap cannot start a second flight.
    expect(body).toContain("busy");
    expect(body).toContain("finished");
  });
});

describe("Reduce Motion: a crossfade, and a still skeleton", () => {
  test("Reduce Motion: the crossfade, and a still skeleton", () => {
    expect(LAYER).toContain("reduceMotion");
    expect(LAYER).toContain("morphLook(");
    // The reduce-motion branch reaches for the crossfade's own constant and never a
    // flight duration: `motion.flightMs` is only read on the morph branch.
    expect(between(LAYER, 'motion.kind === "crossfade"', "Animated.parallel")).toContain(
      "CROSSFADE_MS",
    );
  });

  test("the route reads the flag LIVE (a toggle converges without a restart)", () => {
    const route = between(APP, "function WorkflowRunRoute", "\nfunction ");
    expect(route).toContain("useAccessibilityFlags()");
    expect(route).toContain("reduceMotion={flags.reduceMotion}");
  });

  test("the skeleton is stilled, never removed (`skeletonBars` takes the flag)", () => {
    // The layer's log block IS the skeleton while the read is in flight, and it takes
    // Reduce Motion from the same flag — same boxes, stilled motion.
    expect(LAYER).toContain("skeletonBars(blocks, width, reduceMotion)");
    expect(LAYER).toContain('bar.motion === "still"');
  });
});

describe("the tap → the controller's `openStep`, never a screen-local selection", () => {
  test("the graph node, the B row and the prev/next arrow open through the passed callback", () => {
    expect(RUN).toContain("onOpenStep(node.id)");
    // S7: a B row names its VISIT, and so does an arrow (a step that ran twice).
    expect(RUN).toContain("onOpenStep(entry.step, visitOf(entry))");
    expect(LAYER).toContain("onOpenStep(side.step, side.visit)");
    expect(RUN).not.toContain("setState({ openStepId");
  });

  test("the route forwards them to the controller", () => {
    const route = between(APP, "function WorkflowRunRoute", "\nfunction ");
    expect(route).toContain("controller.openStep(stepId, visit)");
    expect(route).toContain("controller.closeStep()");
    // The read is the controller's (it knows the run and the attempt).
    expect(route).not.toContain("workflowStep(");
    expect(APP).not.toContain("session.workflowStep(");
  });

  test("the back reverses the morph (it does not pop the stack)", () => {
    expect(LAYER).toContain("onClose");
    expect(LAYER).not.toContain("goBack(");
  });
});

/**
 * docs/fix/workflows-ux.md S3 (defect 3): the drawn layer must PUT the numbers the
 * pure module computes. Screenshot d1b5faaa showed the hero at the sheet's inset —
 * above the clock and behind the back chevron — so the properties here are that
 * the layer reads the safe-area top, that the hero's `y` comes from `heroTop`, and
 * that the nav bar is the box that owns the inset (nothing else draws at y = 0).
 */
describe("S3 · the layer draws the nav bar under the safe area and the hero below it", () => {
  const body = between(LAYER, "export function WorkflowStepLayer", "\n}");

  test("the layer reads the safe-area top, and the hero's top comes from the pure module", () => {
    expect(LAYER).toContain("useSafeAreaInsets()");
    expect(body).toContain("heroTop(insets.top)");
    // The flight is given that top — NOT the sheet's inset, which was the bug.
    // S6b: the flight starts from a pill the RUN's layout placed, so it takes the
    // shared projection rather than the bare step rows.
    expect(body).toContain("flight(props.projection, step.id, canvas, top, DETAIL.inset, width)");
    expect(body).not.toContain("flight(steps, step.id, canvas, DETAIL.inset, width)");
  });

  test("the nav bar carries the inset, and the hero is one gap below the bar", () => {
    expect(body).toContain("paddingTop: insets.top");
    // The bar's content row is the pure module's own height (not a literal), and
    // the gap between it and the pill is that module's gap.
    expect(LAYER).toContain("height: STEP_NAV.height");
    expect(body).toContain("STEP_NAV.gap + hero.height");
    // The back row is INSIDE the bar (no second, un-inset row at y = 0).
    expect(body.indexOf("styles.nav")).toBeLessThan(body.indexOf('testID="workflow-step-back"'));
  });

  test("the bar says the run's name and `N of M` — both from the pure `stepNav` (S7: B's visits)", () => {
    expect(RUN).toContain("stepNav(projection, openCard.step.id, run.name, state.openVisit)");
    expect(body).not.toContain("navText(");
    expect(body).toContain("{nav.back}");
    expect(body).toContain("{nav.position}");
    expect(body).toContain('testID="workflow-step-position"');
  });

  test("the body's spacer accounts for the bar's gap as well as the hero", () => {
    // A spacer of the hero alone would let the first kv row slide under the pill.
    expect(body).toContain("STEP_NAV.gap + hero.height");
  });

  test("the run screen gives it the run's name (the bar's back label)", () => {
    expect(RUN).toContain("runName={run.name}");
  });
});
