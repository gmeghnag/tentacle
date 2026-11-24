/**
 * The editor screen's wiring (docs/feat/workflow-editor.md D8, slice 7a): read
 * from the sources, like `workflow-screens-wiring.test.ts` / `workflow-start-wiring`
 * .test.ts, because these are exactly the rules a renderer harness cannot see.
 *
 * I know X for sure: D7's controller is the ONE state machine (it sends, saves and
 * decides every refusal), D6's geometry is the ONE drawing, and a `.tsx` here must
 * only paint (AGENTS §7). My current hypothesis is Y: therefore the route attaches
 * through `RUNTIMES.controller` → `open` (never `reopen`), and the screen's own
 * source shows no wire call, no `useEffect` and no decision beyond mapping. My next
 * cheapest test is Z: these assertions on the sources.
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
const ROUTES = code(read("src", "routes.ts"));
const EDIT = code(read("src", "screens", "WorkflowEdit.tsx"));
const SHEETS = code(read("src", "screens", "WorkflowEditSheets.tsx"));
const RUNS = code(read("src", "screens", "WorkflowRuns.tsx"));
const START = code(read("src", "screens", "WorkflowStart.tsx"));

/** `src` from `from` to the first `to` after it. */
function between(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf(to, at + from.length);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("the route is registered, declared and plain", () => {
  test("the stack has a WorkflowEdit screen and the params type names it", () => {
    expect(APP).toContain('name="WorkflowEdit"');
    expect(ROUTES).toContain("WorkflowEdit: WorkflowEditRoute");
    expect(ROUTES).toContain("export interface WorkflowEditRoute");
  });

  test("`name` is OPTIONAL: absent means create (the New sheet names the file)", () => {
    const route = between(ROUTES, "export interface WorkflowEditRoute", "\n}");
    expect(route).toContain("computerId: string");
    expect(route).toContain("sessionId: string");
    expect(route).toContain("name?: string");
  });

  test("a plain push screen: no <Modal>, no Sheet route, headerShown false", () => {
    const block = between(APP, 'name="WorkflowEdit"', "</Stack.Screen>");
    expect(block).not.toContain("<Modal");
    expect(block).not.toContain('navigate("Sheet"');
    expect(block).toContain("headerShown: false");
  });
});

describe("the route reuses the ONE session path (§7)", () => {
  const route = between(APP, "function WorkflowEditRoute", "\nfunction ");

  test("it attaches through RUNTIMES and never with `reopen` (archive rule)", () => {
    expect(route).toContain("RUNTIMES.controller(link.client)");
    expect(route).toContain("runtime.open(id)");
    expect(route).not.toContain("reopen");
  });

  test("a session another screen follows is borrowed, never left from here", () => {
    expect(route).toContain("borrowed: runtime.follows(sessionId)");
    expect(route).toContain("runtime.leave(sessionId)");
  });

  test("it holds the ONE controller and sends nothing itself", () => {
    expect(route).toContain("createWorkflowEditController");
    expect(route).not.toContain("workflowSave(");
    expect(route).not.toContain("workflowSource(");
    expect(route).not.toContain("permissions");
  });

  test("the link's own status feeds the controller (offline editing, D7)", () => {
    expect(route).toContain("onStatus");
    expect(route).toContain("setLink(");
  });

  test("the controller is disposed on unmount, and the draft is never re-sent from here", () => {
    expect(route).toContain("dispose()");
    expect(route).not.toContain("confirmSave");
  });
});

describe("the screen is a dumb renderer", () => {
  test("no wire call, no effect, no gesture decision: everything comes from the modules", () => {
    expect(EDIT).not.toContain("useEffect");
    expect(EDIT).not.toContain("workflowSave");
    expect(EDIT).not.toContain("workflowSource");
    // Not one geometry call and not one intent: the route makes them (AGENTS §7).
    expect(EDIT).not.toContain("editGeometry(");
    expect(EDIT).not.toContain("editTargetAt");
    expect(EDIT).not.toContain("tapIntent");
    expect(EDIT).not.toContain("applyIntent");
    expect(EDIT).not.toContain("portRelease");
    expect(EDIT).not.toContain("dropTargetAt");
    // What it DOES read: the three strings it prints and the menu model it maps.
    expect(EDIT).toContain("editMenuModel");
    expect(EDIT).toContain("barLine(");
    expect(EDIT).toContain("draftCaption(");
  });

  test("the route owns the whole gesture path and the undo toast", () => {
    const route = between(APP, "function WorkflowEditRoute", "\nfunction ");
    for (const call of [
      "tapIntent(",
      "portRelease(",
      "applyIntent(",
      "deletedToast(",
      "editGeometry(",
      "validDropTargets(",
      "menuInputs(",
    ]) {
      expect(route).toContain(call);
    }
  });

  test("a menu row DISARMS the port: Delete must not leave a ✗ aimed at a gone step", () => {
    // The menu is not the canvas. Keeping the arm through it means that after
    // "Delete" on the armed step, the next tap on ANY step is still read as a drop
    // onto a step that no longer exists: the step never opens, and the bar shows
    // `no step "gate"` instead. One rule, in the module (`menuGesture`).
    const route = between(APP, "function WorkflowEditRoute", "\nfunction ");
    expect(route).toContain("menuGesture(");
    // The intent never reaches `act` without passing through it.
    expect(route).not.toContain("act({ armed, intent })");
  });

  test("the header is Cancel / title + state / Save, DIM and never hidden", () => {
    expect(EDIT).toContain('testID="workflow-edit-cancel"');
    expect(EDIT).toContain('testID="workflow-edit-save"');
    expect(EDIT).toContain("draftCaption(");
    // Save is disabled, never conditional-absent: a missing control is a mystery.
    const save = between(EDIT, 'testID="workflow-edit-save"', "/>");
    expect(save).toContain("disabled=");
    expect(save).not.toContain("? null");
  });

  test("the bottom bar shows the file's state, with the first problem VERBATIM", () => {
    expect(EDIT).toContain('testID="workflow-edit-bar"');
    expect(EDIT).toContain("barLine(");
    // Never truncated: a validator sentence cut short is one you cannot act on.
    const bar = between(EDIT, 'testID="workflow-edit-bar-text"', "</Text>");
    expect(bar).not.toContain("numberOfLines");
  });

  test("the graph is drawn from the geometry: svg paths, absolutely positioned pills", () => {
    expect(EDIT).toContain("react-native-svg");
    for (const id of [
      "workflow-edit-canvas",
      "workflow-edit-node-",
      "workflow-edit-plus-",
      "workflow-edit-port-",
      "workflow-edit-label-",
    ]) {
      expect(EDIT).toContain(id);
    }
    // A ghost pill is DRAWN, never hidden: the break has to be visible.
    expect(EDIT).toContain("ghost");
  });

  test("the long-press menu and its undo toast are the model's, not the view's", () => {
    expect(EDIT).toContain("editMenuModel");
    expect(EDIT).toContain('testID="workflow-edit-menu"');
    expect(EDIT).toContain('testID="workflow-edit-undo"');
  });

  test("the screens that say why there is no editor at all are all drawn", () => {
    for (const id of [
      "workflow-edit-broken",
      "workflow-edit-unreadable",
      "workflow-edit-unsupported",
      "workflow-edit-unavailable",
      "workflow-edit-changed",
    ]) {
      expect(EDIT).toContain(id);
    }
  });

  test("the canvas ground is UNDER the pills: drawn first, so it never swallows their taps", () => {
    // React Native stacks later siblings on top: an absoluteFill ground drawn after
    // the pills would take every touch meant for a step, a ＋, a ✗ or a label.
    const canvas = between(EDIT, "function Canvas", "\nfunction ");
    const ground = canvas.indexOf('testID="workflow-edit-ground"');
    expect(ground).toBeGreaterThan(-1);
    for (const drawn of ["<Pill", "<Plus", "<Port", "workflow-edit-label-"]) {
      expect(canvas.indexOf(drawn)).toBeGreaterThan(ground);
    }
  });

  test("a ✗ drag resolves where the finger LIFTS, and the scroll view cannot steal it", () => {
    // `Pressable.onPressOut` fires as soon as the touch leaves the port's retention
    // box, so a drag would resolve at the port's edge, never on the step it ends on.
    const port = between(EDIT, "function Port", "\nfunction ");
    expect(port).not.toContain("onPressOut");
    expect(port).toContain("onPanResponderRelease");
    expect(port).toContain("onPanResponderTerminationRequest: () => false");
  });

  test("no <Modal>: the sheets are 7b's, and the hub button is not this screen's", () => {
    expect(EDIT).not.toContain("<Modal");
    expect(EDIT).not.toContain("FloatingActivity");
  });
});

describe("the entries into the editor", () => {
  test("the runs screen's empty state offers New workflow", () => {
    expect(RUNS).toContain('testID="workflow-runs-new"');
    expect(RUNS).toContain("onNew");
    // Only with a session: the editor saves through THAT session's daemon.
    expect(RUNS).toContain("props.sessionId === undefined");
  });

  test("the catalogue offers Edit on a VALID row and on a broken one (it opens as a draft)", () => {
    expect(START).toContain("testID={`workflow-start-edit-${entry.name}`}");
    expect(START).toContain("onEdit");
    const broken = between(START, "function BrokenRow", "function Detail");
    expect(broken).toContain("workflow-start-edit-");
    // A broken file is never started: Edit is the ONLY way out of that row.
    expect(broken).not.toContain("workflow-start-run");
  });

  test("the catalogue has its own New workflow button (D8), wired to create mode", () => {
    expect(START).toContain('testID="workflow-start-new"');
    expect(START).toContain("props.onNew");
    const route = between(APP, "function WorkflowStartRoute", "\nfunction ");
    expect(route).toContain("onNew={onNew}");
  });

  test("every entry pushes the route with identity only (never content)", () => {
    expect(APP).toContain('navigate("WorkflowEdit"');
    const pushes = APP.split('navigate("WorkflowEdit"').length - 1;
    // Runs' empty state, the catalogue's New workflow and a row's Edit.
    expect(pushes).toBeGreaterThanOrEqual(3);
    // Identity only: the session and the file's name, never a draft.
    expect(APP).toContain("computerId: route.params.computerId");
    expect(APP).toContain("sessionId: route.params.sessionId");
  });
});

/**
 * Slice 7b: the sheets. The same rule as above, one layer further — the ROUTE holds
 * the sheet (a state), the pure module decides which one and what a control means,
 * and `WorkflowEditSheets.tsx` paints it. A `1` here is a rule in the wrong file.
 */
describe("the sheets are a state on the route, decided by the module (7b)", () => {
  const route = between(APP, "function WorkflowEditRoute", "\nfunction ");

  test("`insert` and `open` are no longer dropped: they open a sheet", () => {
    // 7a reported them and lost them. The kind picker and the step sheet are the
    // two gestures the graph is FOR, so the intent must reach them.
    expect(route).toContain("insert: (at) => setSheet(sheetForIntent({");
    expect(route).toContain("open: (id, which) => setSheet(sheetForIntent({");
    // Both through the module's ONE answer, never a `{kind: …}` built here.
    expect(route.split("sheetForIntent(").length - 1).toBe(2);
  });

  test("the sheet is re-derived from the draft on screen, never stored", () => {
    // A stored model would keep a stepper value or a deleted step's title after
    // the edit that changed it: `sheetModel` reads the draft each render.
    expect(route).toContain("sheetModel({");
    expect(route).toContain("draft: state.draft");
    expect(route).toContain("prompts: state.prompts");
    // The session's own vocabulary, optional: a session with no picker named sends
    // no list, which the model reads as "this sheet has no model row".
    expect(route).toContain("state.context?.models");
    expect(route).toContain("state.context?.agentTypes");
    // The controller's refusal is the sheet's note, verbatim.
    expect(route).toContain("notice: state.notice");
  });

  test("a control ends in ONE controller call, through `applySheetAction`", () => {
    for (const call of [
      "applySheetAction(",
      "textAction(",
      "stepperAction(",
      "segmentAction(",
      "choiceAction(",
      "sheetAfterAction(",
    ]) {
      expect(route).toContain(call);
    }
    // The mapping is one method for one action: no branch, no second meaning.
    for (const method of [
      "controller.insert(",
      "controller.patch(",
      "controller.rename(",
      "controller.prompt(",
      "controller.setRetry(",
      "controller.setFail(",
      "controller.setGotoMax(",
      "controller.setNext(",
      "controller.edit(",
    ]) {
      expect(route).toContain(method);
    }
  });

  test("no `!` assertion anywhere in the sheet path: a missing model is a guard", () => {
    // The repo's style, and here it is also the only safe shape: an assertion would
    // reach a control's handler while `sheetModel` had just returned null (a step
    // deleted under the sheet), and throw on the render thread.
    for (const source of [route, SHEETS, code(read("src", "workflow-edit-sheets.ts"))]) {
      expect(source).not.toMatch(/\bmodel!/);
      expect(source).not.toMatch(/sheetView!/);
      expect(source).not.toMatch(/\bmodel\)!/);
    }
    // What it does instead: a guard, and `null` is the module's own "do nothing".
    expect(route).toContain("if (sheet !== null && sheetView !== null)");
  });

  test("Settings is reachable: the mockup's entry is the title", () => {
    // D8 lists the workflow Settings (description, inputs, budget) and the mockup
    // opens them "dal titolo". Nothing else on this screen could mean Settings, and
    // the file's name is not renamed here.
    expect(route).toContain('setSheet({ kind: "settings" })');
    expect(EDIT).toContain("onTitlePress={props.onSettings}");
    // The header keeps its Cancel / title / Save shape: Settings is the TITLE tap,
    // not a third button (7a's header contract, asserted above).
    expect(EDIT).toContain('titleTestID="workflow-edit-title"');
  });
});

describe("the sheet screen is a dumb renderer (7b)", () => {
  test("no effect, no wire call, no controller: every rule is the module's", () => {
    expect(SHEETS).not.toContain("useEffect");
    expect(SHEETS).not.toContain("workflowSave");
    expect(SHEETS).not.toContain("workflowSource");
    expect(SHEETS).not.toContain("controller.");
    // Not one decision either: the model arrives decided.
    for (const call of [
      "textAction(",
      "stepperAction(",
      "segmentAction(",
      "choiceAction(",
      "sheetModel(",
      "sheetForIntent(",
      "applySheetAction(",
    ]) {
      expect(SHEETS).not.toContain(call);
    }
    // What it DOES read: the types and the detent table.
    expect(SHEETS).toContain("SheetModel");
    expect(SHEETS).toContain("SHEET_DETENT");
  });

  test("it is a Modal overlay, not a stack route: the graph stays underneath", () => {
    expect(SHEETS).toContain("<Modal");
    expect(SHEETS).not.toContain("navigate(");
    // The detent is a fraction of the window, so "short" is short on every device.
    expect(SHEETS).toContain("useWindowDimensions");
    expect(SHEETS).toContain("SHEET_DETENT[detent]");
  });

  test("every control is named, so the e2e flow can press it (7c)", () => {
    for (const id of [
      "workflow-sheet",
      "workflow-sheet-cancel",
      "workflow-sheet-title",
      "workflow-sheet-done",
      "workflow-sheet-scroll",
      "workflow-sheet-section-",
      "workflow-sheet-field-",
      "workflow-sheet-input-",
      "workflow-sheet-stepper-",
      "workflow-sheet-minus-",
      "workflow-sheet-plus-",
      "workflow-sheet-value-",
      "workflow-sheet-seg-",
      "workflow-sheet-choice-",
      "workflow-sheet-pick-",
    ]) {
      expect(SHEETS).toContain(id);
    }
  });

  test("a disabled row says why in the words it is disabled with", () => {
    // The goto picker's `itself — use Retry instead` (the core's own sentence) is a
    // `sub` on a row that cannot be pressed: dim AND explained, never just dim.
    expect(SHEETS).toContain("choice.off ? styles.dim : null");
    expect(SHEETS).toContain("disabled={choice.off}");
    expect(SHEETS).toContain("choice.sub");
  });
});
