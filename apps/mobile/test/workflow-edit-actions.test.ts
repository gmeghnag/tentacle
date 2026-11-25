/**
 * docs/feat/workflow-editor.md D8, slice 7a — the editor's tap → intent table, its
 * long-press menu and the two lines the header/bar show. Pure, so no renderer.
 *
 * I know X for sure: `editTargetAt`/`dropTargetAt` (slice 5) already decide WHICH
 * thing a point hits and which steps a `✗` port may land on, and D6 requires the
 * one-handed path (tap the port, then tap a step) to agree with the drag. My
 * current hypothesis is Y: therefore the only decision left on the screen's path
 * is an armed-port state machine plus the menu model, which is these assertions.
 * My next cheapest test is Z: this file.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowDraft } from "@tentacle/core";
import {
  type EditMenuItem,
  MENU_GAP,
  applyIntent,
  barLine,
  deletedToast,
  draftCaption,
  dragIntent,
  drawnSteps,
  editMenuModel,
  menuGesture,
  menuHeight,
  menuInputs,
  menuPlacement,
  portRelease,
  tapIntent,
  toastFor,
  versionOfDraft,
} from "../src/workflow-edit-actions.ts";
import { editGeometry } from "../src/workflow-edit-graph.ts";

const DRAFT: WorkflowDraft = {
  schemaVersion: 1,
  name: "demo",
  version: 1,
  steps: [
    { id: "plan", agent: { prompt_text: "plan" } },
    { id: "gate", run: "bun run check", on_fail: { goto: "plan", max: 2 } },
    { id: "merge", approve: { title: "merge" } },
  ],
};

describe("a tap's meaning (the armed-✗ state machine)", () => {
  test("a ＋ says where to insert, armed or not", () => {
    expect(tapIntent(null, { kind: "plus", insertAt: { end: true } })).toEqual({
      armed: null,
      intent: { kind: "insert", at: { end: true } },
    });
    expect(tapIntent("gate", { kind: "plus", insertAt: { after: "plan" } })).toEqual({
      armed: null,
      intent: { kind: "insert", at: { after: "plan" } },
    });
  });

  test("a ✗ port ARMS itself, and a re-tap is the same arm (never a toggle off)", () => {
    expect(tapIntent(null, { kind: "port", id: "gate" })).toEqual({
      armed: "gate",
      intent: { kind: "none" },
    });
    expect(tapIntent("gate", { kind: "port", id: "gate" })).toEqual({
      armed: "gate",
      intent: { kind: "none" },
    });
    // Another step's port re-arms to THAT step: one port is ever armed.
    expect(tapIntent("gate", { kind: "port", id: "merge" })).toEqual({
      armed: "merge",
      intent: { kind: "none" },
    });
  });

  test("a step tapped while a port is armed is the DROP — the drag's own rule", () => {
    expect(tapIntent("gate", { kind: "node", id: "plan" })).toEqual({
      armed: null,
      intent: { kind: "saveFail", id: "gate", target: "plan" },
    });
  });

  test("a step tapped with nothing armed opens it (7b's step sheet)", () => {
    expect(tapIntent(null, { kind: "node", id: "gate" })).toEqual({
      armed: null,
      intent: { kind: "open", id: "gate" },
    });
  });

  test("a label opens the step the edge LEAVES, on that edge's own field", () => {
    expect(tapIntent(null, { kind: "label", id: "gate", which: "fail" })).toEqual({
      armed: null,
      intent: { kind: "open", id: "gate", which: "fail" },
    });
  });

  test("a label or the canvas DISARMS a port, so the next tap means a tap again", () => {
    expect(tapIntent("gate", { kind: "label", id: "gate", which: "retry" }).armed).toBeNull();
    expect(tapIntent("gate", null)).toEqual({ armed: null, intent: { kind: "none" } });
    expect(tapIntent(null, null)).toEqual({ armed: null, intent: { kind: "none" } });
  });
});

describe("a ✗ port released (the drag path, through `dropTargetAt`)", () => {
  const geometry = editGeometry(DRAFT);
  const node = (id: string) => {
    const found = geometry.nodes.find((candidate) => candidate.id === id);
    expect(found).toBeDefined();
    return found as (typeof geometry.nodes)[number];
  };
  const at = (id: string): [number, number] => [node(id).x + 10, node(id).y + 10];

  test("released on another step: that step is the fail target", () => {
    const [x, y] = at("plan");
    expect(dragIntent(geometry, "gate", x, y)).toEqual({
      armed: null,
      intent: { kind: "saveFail", id: "gate", target: "plan" },
    });
  });

  test("released on its OWN step is `self`, and still goes to the core to be refused", () => {
    const [x, y] = at("gate");
    expect(dragIntent(geometry, "gate", x, y)).toEqual({
      armed: null,
      intent: { kind: "saveFail", id: "gate", target: "self" },
    });
  });

  test("released over nothing: put down, nothing changes", () => {
    expect(dragIntent(geometry, "gate", -50, -50)).toEqual({
      armed: null,
      intent: { kind: "none" },
    });
  });

  test("ONE release handler: a touch inside the port's own box is the TAP, not a drag", () => {
    const port = geometry.ports.find((candidate) => candidate.id === "gate");
    expect(port).toBeDefined();
    if (port === undefined) {
      return;
    }
    // A few points inside its own hit box: the one-handed path arms it.
    expect(portRelease(null, geometry, "gate", 2, 2)).toEqual({
      armed: "gate",
      intent: { kind: "none" },
    });
    // Already armed and re-tapped: still armed, never toggled off by accident.
    expect(portRelease("gate", geometry, "gate", 2, 2)).toEqual({
      armed: "gate",
      intent: { kind: "none" },
    });
  });

  test("...and the same handler is a DRAG once the touch leaves that box", () => {
    const port = geometry.ports.find((candidate) => candidate.id === "gate");
    expect(port).toBeDefined();
    if (port === undefined) {
      return;
    }
    // The touch is measured INSIDE the port's view; the box is added back here.
    const [x, y] = at("plan");
    expect(portRelease(null, geometry, "gate", x - port.hit.x, y - port.hit.y)).toEqual({
      armed: null,
      intent: { kind: "saveFail", id: "gate", target: "plan" },
    });
  });

  test("a release for a port that is not drawn changes nothing at all", () => {
    expect(portRelease("gate", geometry, "nope", 0, 0)).toEqual({
      armed: null,
      intent: { kind: "none" },
    });
  });
});

describe("the long-press menu (D8's own list)", () => {
  const labels = (items: readonly EditMenuItem[]) => items.map((item) => item.label);
  const item = (items: readonly EditMenuItem[], label: string): EditMenuItem => {
    const found = items.find((candidate) => candidate.label === label);
    expect(found).toBeDefined();
    return found as EditMenuItem;
  };
  const menu = (index: number, dangling: string[] = []) =>
    editMenuModel({ id: "gate", dangling, index, count: 6 });

  test("the six actions in the mockup's order, Delete last and destructive", () => {
    expect(labels(menu(2).items)).toEqual([
      "Open",
      "Insert after",
      "Duplicate",
      "Move up",
      "Move down",
      "Delete",
    ]);
    expect(item(menu(2).items, "Delete").destructive).toBe(true);
    expect(menu(2).items.filter((entry) => entry.destructive)).toHaveLength(1);
    // Glyph AND word: the owner is colour-blind, so never meaning by hue alone.
    for (const entry of menu(2).items) {
      expect(entry.glyph.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(1);
    }
  });

  test("every row says what it does, so the screen calls the controller and decides nothing", () => {
    expect(item(menu(1).items, "Open").intent).toEqual({ kind: "open", id: "gate" });
    expect(item(menu(1).items, "Insert after").intent).toEqual({
      kind: "insert",
      at: { after: "gate" },
    });
    expect(item(menu(1).items, "Duplicate").intent).toEqual({ kind: "duplicate", id: "gate" });
    expect(item(menu(1).items, "Move up").intent).toEqual({ kind: "move", id: "gate", by: -1 });
    expect(item(menu(1).items, "Move down").intent).toEqual({ kind: "move", id: "gate", by: 1 });
    expect(item(menu(1).items, "Delete").intent).toEqual({ kind: "remove", id: "gate" });
  });

  test("the ends of the list are DIM, never hidden (a move that cannot move)", () => {
    const first = menu(0).items;
    expect(item(first, "Move up").off).toBe(true);
    expect(item(first, "Move down").off).toBe(false);
    const last = menu(5).items;
    expect(item(last, "Move up").off).toBe(false);
    expect(item(last, "Move down").off).toBe(true);
    // Only the moves are ever dimmed: a delete is always offered.
    expect(item(last, "Delete").off).toBe(false);
    expect(item(first, "Open").off).toBe(false);
  });

  test("Delete says what it breaks BEFORE it happens (`deleteStep`'s `dangling`)", () => {
    expect(menu(3).note).toBeNull();
    expect(menu(3, ["review"]).note).toBe("1 link points here: review");
    expect(menu(3, ["exec", "review"]).note).toBe("2 links point here: exec, review");
  });

  test("the undo toast's text names the step that went (the mockup's `Deleted gate`)", () => {
    expect(deletedToast("gate")).toBe("Deleted gate");
  });
});

describe("the dispatcher: every intent becomes exactly ONE controller call", () => {
  const calls: string[] = [];
  const actions = {
    insert: (at: unknown) => calls.push(`insert ${JSON.stringify(at)}`),
    open: (id: string, which?: string) => calls.push(`open ${id} ${which ?? "-"}`),
    duplicate: (id: string) => calls.push(`duplicate ${id}`),
    move: (id: string, by: number) => calls.push(`move ${id} ${by}`),
    remove: (id: string) => calls.push(`remove ${id}`),
    setFail: (id: string, target: string) => calls.push(`setFail ${id} ${target}`),
  };
  const run = (intent: Parameters<typeof applyIntent>[1]) => {
    calls.length = 0;
    applyIntent(actions, intent);
    return calls;
  };

  test("the completed edits reach the controller's own method, once each", () => {
    expect(run({ kind: "saveFail", id: "gate", target: "plan" })).toEqual(["setFail gate plan"]);
    expect(run({ kind: "duplicate", id: "gate" })).toEqual(["duplicate gate"]);
    expect(run({ kind: "move", id: "gate", by: -1 })).toEqual(["move gate -1"]);
    expect(run({ kind: "remove", id: "gate" })).toEqual(["remove gate"]);
  });

  test("a `self` drop is handed to the core unchanged (its refusal is the wording)", () => {
    expect(run({ kind: "saveFail", id: "gate", target: "self" })).toEqual(["setFail gate self"]);
  });

  test("the two sheet-owned intents are forwarded, never guessed", () => {
    expect(run({ kind: "insert", at: { after: "plan" } })).toEqual(['insert {"after":"plan"}']);
    expect(run({ kind: "open", id: "gate", which: "fail" })).toEqual(["open gate fail"]);
    expect(run({ kind: "open", id: "gate" })).toEqual(["open gate -"]);
  });

  test("`none` calls nothing at all", () => {
    expect(run({ kind: "none" })).toEqual([]);
  });

  test("a menu row DISARMS the port, so Delete never leaves a ✗ aimed at a gone step", () => {
    // The menu is not the canvas: its rows are commands, and one of them deletes
    // the step the arm names. The intent itself is untouched.
    expect(menuGesture({ kind: "remove", id: "gate" })).toEqual({
      armed: null,
      intent: { kind: "remove", id: "gate" },
    });
    expect(menuGesture({ kind: "duplicate", id: "gate" }).armed).toBeNull();
    // And the consequence that earns the rule: the next tap on a step is a TAP
    // again, never a drop onto the id that just went.
    const after = tapIntent(menuGesture({ kind: "remove", id: "gate" }).armed, {
      kind: "node",
      id: "gate",
    });
    expect(after.intent).toEqual({ kind: "open", id: "gate" });
  });
});

describe("the header and the bar's words", () => {
  const caption = (input: {
    phase: string;
    savedVersion?: number | null;
    clean?: boolean;
    version?: number | null;
  }): string =>
    draftCaption({
      phase: input.phase,
      savedVersion: input.savedVersion ?? null,
      clean: input.clean ?? false,
      version: input.version ?? null,
    });

  test("the caption: a draft, Review's promise, or the version that landed", () => {
    expect(caption({ phase: "editing" })).toBe("Draft · not saved");
    expect(caption({ phase: "reviewing" })).toBe("nothing written yet");
    expect(caption({ phase: "saving" })).toBe("nothing written yet");
    expect(caption({ phase: "saved", savedVersion: 3 })).toBe("v3 · saved");
    // A `saved` phase with no version reported still never claims a version.
    expect(caption({ phase: "saved" })).toBe("Draft · not saved");
  });

  test("a saved file reopened with no edit is NOT a draft: it is the file, at its version (N4)", () => {
    // Validation round 3, N4: opening a file and changing nothing said "Draft ·
    // not saved" over bytes that were already on disk. The mockup keeps "Draft"
    // for what is NOT written yet (`index.html:551`, `:986`) and names the file's
    // own version otherwise (`:638`).
    expect(caption({ phase: "editing", clean: true, version: 1 })).toBe("v1 · saved");
    expect(caption({ phase: "editing", clean: true, version: 4 })).toBe("v4 · saved");
    // The FIRST edit makes it a draft again — the version it will bump FROM does
    // not make written bytes of unwritten ones.
    expect(caption({ phase: "editing", clean: false, version: 4 })).toBe("Draft · not saved");
    // A create is never clean: there is no file to be saved at.
    expect(caption({ phase: "editing", clean: false, version: 1 })).toBe("Draft · not saved");
    // No `version:` in the draft: nothing to claim, but it is still WRITTEN, so
    // the draft wording would be a lie — it says "Saved", never a version.
    expect(caption({ phase: "editing", clean: true })).toBe("Saved");
  });

  test("`versionOfDraft` reads only a real version, never a string or a zero", () => {
    expect(versionOfDraft(DRAFT)).toBe(1);
    expect(versionOfDraft({ schemaVersion: 1, version: 7 })).toBe(7);
    expect(versionOfDraft({ schemaVersion: 1 })).toBeNull();
    expect(versionOfDraft({ schemaVersion: 1, version: 0 })).toBeNull();
    expect(versionOfDraft({ schemaVersion: 1, version: "3" })).toBeNull();
    expect(versionOfDraft(null)).toBeNull();
  });

  test("the bar: the first problem VERBATIM (its YAML path), else the state in words", () => {
    expect(barLine({ saveOff: "steps[0].run: should not be empty", steps: 3 })).toBe(
      "steps[0].run: should not be empty",
    );
    expect(barLine({ saveOff: null, steps: 7 })).toBe("Valid · 7 steps");
    expect(barLine({ saveOff: null, steps: 1 })).toBe("Valid · 1 step");
  });
});

describe("the menu's own inputs, read from the draft (never a second count)", () => {
  test("`menuInputs` takes `dangling` from `deleteStep`'s own answer", () => {
    // "merge" is reached from "gate" by `next`, so deleting `plan` dangles it.
    const inputs = menuInputs({ draft: DRAFT, prompts: {}, id: "plan" });
    expect(inputs.dangling).toEqual(["gate"]);
    // The step's index in `steps:` and that array's length — `editMenuModel`'s dimming.
    expect(inputs.index).toBe(0);
    expect(inputs.count).toBe(3);
  });

  test("the delete is run on a COPY: reading `dangling` never touches the draft", () => {
    const before = JSON.stringify(DRAFT);
    const inputs = menuInputs({ draft: DRAFT, prompts: {}, id: "gate" });
    expect(inputs.dangling).toEqual([]);
    expect(JSON.stringify(DRAFT)).toBe(before);
  });

  test("an id that is not a step has nothing to dangle, and no index at all", () => {
    const inputs = menuInputs({ draft: DRAFT, prompts: {}, id: "nope" });
    expect(inputs.dangling).toEqual([]);
    // -1: `editMenuModel` then dims `Move down` too, and nothing is a legal move.
    expect(inputs.index).toBe(-1);
    expect(inputs.count).toBe(3);
  });

  test("the bar's count is the draft's `steps:`, so a ghost pill is not one of them", () => {
    // `merge` points at `gone`: that draws a THIRD pill (a ghost), but two steps.
    const ghosted = {
      ...DRAFT,
      steps: [
        { id: "plan", agent: { prompt_text: "plan" } },
        { id: "merge", next: "gone" },
      ],
    };
    expect(drawnSteps(ghosted)).toBe(2);
    // A structurally broken draft has no steps at all: zero, never a crash.
    expect(drawnSteps({ schemaVersion: 1 })).toBe(0);
  });
});

/**
 * Validation round 3, P2: the long-press menu was drawn at the overlay's origin,
 * so its first row (`Open`) landed under the clock and the menu was cut by the
 * status bar. The mockup anchors it to the node it belongs to (`index.html:606`:
 * `top: g.y + 50 + 44 + 10 + 6`), which is what `menuPlacement` decides — from the
 * pill's MEASURED top in the window, because the canvas scrolls.
 */
describe("where the long-press menu sits (P2)", () => {
  const WINDOW = 956;
  const INSET = 62;
  const menu = editMenuModel({ id: "gate", dangling: [], index: 2, count: 3 });
  const at = (top: number) =>
    menuPlacement({
      menu,
      nodeTop: top,
      nodeHeight: 50,
      windowHeight: WINDOW,
      insetTop: INSET,
    });

  test("hung UNDER the pressed pill, never pinned at the window's top edge", () => {
    // A pill in the middle of the screen: the menu starts below it plus the gap.
    expect(at(400).top).toBe(400 + 50 + MENU_GAP);
    // The bug's exact shape was 0: a menu whose first row is under the status bar.
    expect(at(400).top).toBeGreaterThan(INSET);
  });

  test("a pill near the bottom: the menu flips ABOVE it rather than past the edge", () => {
    const top = at(WINDOW - 40).top;
    // Above the pill, and fully inside the window (no row cut off).
    expect(top).toBeLessThan(WINDOW - 40);
    expect(top + menuHeight(menu)).toBeLessThanOrEqual(WINDOW);
  });

  test("no measurement from the press: the menu still clears the status bar", () => {
    // A pure-RN event can arrive without numbers. The bug's behaviour — pinned at
    // the overlay's origin — is what a `null` must NOT reproduce.
    expect(at(0).top).toBeGreaterThan(0);
    expect(
      menuPlacement({
        menu,
        nodeTop: null,
        nodeHeight: 50,
        windowHeight: WINDOW,
        insetTop: INSET,
      }).top,
    ).toBe(INSET);
  });

  test("the menu's height is its rows plus the note, so a flip can be planned", () => {
    const items = editMenuModel({ id: "gate", dangling: [], index: 2, count: 3 });
    expect(menuHeight(items)).toBeGreaterThan(items.items.length * 0);
    // The note under Delete is part of the box: a flip that ignored it would cut it.
    const noted = editMenuModel({ id: "gate", dangling: ["review"], index: 2, count: 3 });
    expect(menuHeight(noted)).toBeGreaterThan(menuHeight(items));
  });
});

/**
 * Validation round 3, P3 (the half the pure module owns): the `Deleted … · Undo`
 * toast outlived the draft it undoes — after a Reload it stayed up over the file it
 * had just re-read, and its Undo would have written into a different history. The
 * confirm Reload asks is `reloadConfirm` (`workflow-edit-controller.ts`, next to
 * `discardText`, the wording it reuses).
 */
describe("the undo toast dies with its draft (P3)", () => {
  test("a delete raises it, naming the step that went", () => {
    expect(toastFor("delete", "gate")).toBe("Deleted gate");
  });

  test("undo and a replaced draft take it away — never over a draft it cannot undo", () => {
    // Undo was taken: there is nothing left to undo.
    expect(toastFor("undo")).toBeNull();
    // Reload / Discard: the history the Undo pointed into is GONE. This is the
    // bug: the toast (and its Undo) survived a Reload.
    expect(toastFor("draftReplaced")).toBeNull();
  });
});
