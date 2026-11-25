/**
 * The workflow screens' wiring (docs/feat/workflows-ui.md D4, slice 3), pinned
 * where Bun can reach it. The screens and `App.tsx` are `.tsx` (unimportable from
 * Bun: React Native's sources are Flow), so the structure is pinned from the
 * source — the `hub-tools-wiring.test.ts` pattern. What the screens DRAW comes
 * from `workflow-run-controller.test.ts` / `workflow-runs-controller.test.ts`.
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

const APP = code(read("App.tsx"));
const RUN = code(read("src", "screens", "WorkflowRun.tsx"));
const RUNS = code(read("src", "screens", "WorkflowRuns.tsx"));
const SESSION = code(read("src", "screens", "SessionScreen.tsx"));
const CONTROLLER = code(read("src", "session-screen-controller.ts"));
/** The run's own controller: where the projection and the ask bar are computed (S6b). */
const RUNCTRL = code(read("src", "workflow-run-controller.ts"));

/** `src` from `from` to the first `to` after it. */
const between = (src: string, from: string, to: string): string => {
  const at = src.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf(to, at + from.length);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
};

describe("two plain PUSH screens (never the Sheet route, never a Modal)", () => {
  test("the stack has both routes, and neither screen draws a <Modal>", () => {
    expect(APP).toContain('name="WorkflowRuns"');
    expect(APP).toContain('name="WorkflowRun"');
    expect(RUN).not.toContain("<Modal");
    expect(RUNS).not.toContain("<Modal");
  });
});

describe("the run screen holds only the slim ask row (docs/fix/mobile-ask-surfaces.md D6)", () => {
  test("no inline answer on the run screen: the sheet over the run is the verbatim surface", () => {
    expect(RUN).not.toContain("AskBlock");
    expect(RUN).not.toContain("onAnswer");
    expect(RUN).not.toContain("allow_once");
    expect(RUN).not.toContain("allow_always");
    const panel = between(RUN, "function AskPanel", "\nfunction ");
    expect(panel).toContain("<AskSlim");
    // Own ask (parked): Review. Foreign ask / no sheet: Open the session.
    expect(panel).toContain('"Review"');
    expect(panel).toContain('"Open the session"');
  });

  test("the Session screen presents over its own run, and only that run's ask", () => {
    expect(SESSION).toContain("ownRunTopId(");
    expect(SESSION).toContain("sessionInFront(focused, sheetStack, topRunId !== null)");
    expect(SESSION).toContain("askPresentable(");
  });
});

describe("the run route reuses the ONE session path and the ONE sheet", () => {
  const route = between(APP, "function WorkflowRunRoute", "\nfunction ");

  test("it attaches through RUNTIMES, never with `reopen` (archive rule, §7)", () => {
    expect(route).toContain("RUNTIMES.controller(link.client)");
    expect(route).toContain("runtime.open(id)");
    expect(route).not.toContain("reopen");
  });

  test("asks are answered only through the Session screen's own sheet (single broker)", () => {
    expect(route).toContain("SESSION_SCREENS.get(");
    expect(route).toContain("screen.sheet().answerFor(");
    // No second requester on the broker, no resolve of its own.
    expect(route).not.toContain("permissions");
    expect(route).not.toContain("resolvePermission");
  });

  test("a session another screen follows is borrowed, never left from here", () => {
    expect(route).toContain("borrowed: runtime.follows(sessionId)");
  });
});

/**
 * docs/fix/workflows-ux.md S6b: the run screen draws the SHARED projection through
 * the pure layout/marker/edge modules, and holds no decision of its own — the one
 * property that keeps the phone's graph and the TUI's words from disagreeing (D2:
 * "one truth for not yet / not run on both"). Every assertion here is a
 * source-reading one because a `.tsx` screen is unimportable from Bun.
 */
describe("S6b · the run screen draws the shared projection, never a guess", () => {
  test("it reads the projection from the state, and draws it through the pure modules", () => {
    // The projection is COMPUTED by the controller (one place, one call) and read
    // here: a second `runProjection(row)` on a render path would be a second truth.
    expect(RUNCTRL).toContain("runProjection(run)");
    expect(RUN).toContain("state.projection");
    expect(RUN).not.toContain("runProjection(");
    expect(RUN).toContain("summary(projection");
    expect(RUN).toContain('from "../workflow-run-layout.ts"');
    expect(RUN).toContain("runLayout(");
    expect(RUN).toContain('from "../workflow-marker.ts"');
    expect(RUN).toContain("markerFor(");
    expect(RUN).toContain('from "../workflow-edge.ts"');
    expect(RUN).toContain("edgeLook(");
  });

  test("the retired guess is not read: no graphGeometry, no loop/maxRound heuristic", () => {
    expect(RUN).not.toContain("graphGeometry");
    expect(RUN).not.toContain("workflow-graph.ts");
    expect(RUN).not.toContain("maxRound");
    expect(RUN).not.toContain("isLoopTarget");
  });

  test("no phase or trace is decided here — the words and strokes come from the modules", () => {
    // The wire words that D2 maps are ABSENT: a literal here is a second truth.
    for (const word of ['"pending"', '"needs-approval"', '"skipped"', '"never"', '"later"']) {
      expect({ word, found: RUN.includes(word) }).toEqual({ word, found: false });
    }
  });

  test("the summary strip sits under the header, fed by `summary()`", () => {
    expect(RUN).toContain('testID="workflow-summary"');
    expect(RUN).toContain("summary(projection");
    // It is drawn before the mode branch: both views carry the same strip.
    expect(RUN.indexOf('testID="workflow-summary"')).toBeLessThan(
      RUN.indexOf('state.mode === "graph"'),
    );
  });

  test("ONE ask bar, pinned outside the scrolling content (never one per card)", () => {
    expect(RUN).toContain('testID="workflow-ask"');
    // The bar is handed the ask the controller paired, by its own pure selector.
    expect(RUN).toContain("state.askBar");
    expect(RUNCTRL).toContain("askBarFor(");
    // ONE ask row, never one per card…
    expect(RUN.match(/<AskSlim/g) ?? []).toHaveLength(1);
    // …and it is RENDERED outside the screen's scroll view: the bar mounts after
    // it closes.
    expect(RUN.indexOf("<AskPanel")).toBeGreaterThan(RUN.lastIndexOf("</ScrollView>"));
  });

  test("the edges are stroked from the trace, and the markers from the phase", () => {
    // Neither the dash nor the ink is decided here: `edgeLook`/`markerFor` are.
    expect(RUN).toContain("look.dashArray");
    expect(RUN).toContain("look.stroke");
    expect(RUN).toContain("edgeLook(edge.trace");
    for (const literal of ['"5 4"', '"1 4"', "EDGE_DASH", "EDGE_DOT"]) {
      expect({ literal, found: RUN.includes(literal) }).toEqual({ literal, found: false });
    }
    // The marker is the ONE component that draws a phase, in the pill and in the strip.
    expect(RUN).toContain("<WorkflowMark");
  });
});

describe("the hub entry", () => {
  test("the Session screen offers Workflows only with its callback (P6) and feeds its figure", () => {
    expect(SESSION).toContain("workflows: onOpenWorkflows");
    expect(SESSION).toContain("workflows: workflowsFigure");
  });

  test("the figure is the runs AND the catalogue, folded by ONE pure function (fix D6)", () => {
    const fold = between(SESSION, "const workflowsFigure = workflowsHub(", ");");
    expect(fold).toContain("catalogueFigure(state.catalogue)");
    expect(fold).toContain("workflowsRuns");
    // The catalogue is the CONTROLLER's read, not a second one on the render path.
    expect(SESSION).not.toContain("workflowCatalogue()");
    expect(CONTROLLER).toContain("session?.workflowCatalogue?.bind(session)");
    // Asked ONCE per attach, beside the artifacts read (never on render).
    expect(CONTROLLER).toContain("void readCatalogue();");
  });

  test("the hub no longer offers Attach: the composer's `+` is the one chooser", () => {
    expect(SESSION).not.toContain("attach: openAttach");
    // …and `openAttach` is still the composer's photo button.
    expect(SESSION).toContain("onPhoto={openAttach}");
  });
});
