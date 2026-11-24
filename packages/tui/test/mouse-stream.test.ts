/**
 * docs/feat/app-decomposition.md S4 — `mouse-stream.ts`, the mouse layer's two
 * pure decisions, unit-tested without React:
 *
 * 1. `stepMouseChunk` — the chunk state machine. A chunk may carry any number of
 *    complete SGR reports plus a half-delivered one; a half-delivered one may
 *    also be all a chunk carries, and a bare `[` is indistinguishable from a
 *    typed bracket until the hold expires or the next chunk decides it. The
 *    failure modes here are: a report byte leaking into the input (no hold), a
 *    typed key swallowed by the hold (a `[` never restored), a restored bracket
 *    lost behind a panel, and a restored `[` not carried into the same-event
 *    Enter.
 *
 * 2. `dispatchMouse` — ONE report in, effects out. The priority order is the
 *    safety property (the wheel before the panel, the panel before the dock, the
 *    dock before the click recogniser, the click before the selection), and the
 *    state threading is the freshness property: a coalesced press+drag+release
 *    chunk is copied with NO render between its reports.
 */
import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import type { BackgroundListView } from "../src/background-list.ts";
import {
  type MouseSnapshot,
  type MouseState,
  WHEEL_LINES,
  dispatchMouse,
  plainKeyOf,
  stepMouseChunk,
} from "../src/mouse-stream.ts";
import type { MouseReport } from "../src/mouse.ts";
import { type LaidItem, sliceLaid } from "../src/render-lines.ts";
import { CLICK_IDLE } from "../src/tool-expand.ts";
import type { PanelView } from "../src/tree-panel.ts";

/** A minimal Ink `Key`: the fields this layer reads, all false (a "plain" keypress). */
const keyOf = (over: Record<string, boolean> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...over,
});
const NONE_KEY = keyOf();
const RETURN_KEY = keyOf({ return: true });
const ESCAPE_KEY = keyOf({ escape: true });

const report = (btn: number, x: number, y: number, press = true): MouseReport => ({
  btn,
  x,
  y,
  press,
});

const chunk = (held: string, char: string, opts: { key?: Key; panelOpen?: boolean } = {}) =>
  stepMouseChunk({ held, char, key: opts.key ?? NONE_KEY, panelOpen: opts.panelOpen ?? false });

describe("S4 stepMouseChunk: the SGR chunk state machine", () => {
  test("a complete report is dispatched, and nothing is held", () => {
    const step = chunk("", "[<64;10;5M");
    expect(step.reports).toEqual([{ btn: 64, x: 10, y: 5, press: true }]);
    expect(step.hold).toBeNull();
    expect(step.restored).toBe("");
    expect(step.verdict).toBe("consumed");
  });

  test("a coalesced chunk dispatches EVERY report, in order (escaped separators too)", () => {
    const step = chunk("", "[<65;1;1M\x1b[<65;2;2M[<65;3;3M");
    expect(step.reports.map((r) => r.y)).toEqual([1, 2, 3]);
    expect(step.reports.every((r) => r.btn === 65)).toBe(true);
    expect(step.verdict).toBe("consumed");
  });

  test("a trailing half report after complete ones is HELD, never typed", () => {
    const step = chunk("", "[<65;1;1M[<65;2;");
    expect(step.reports).toHaveLength(1);
    expect(step.hold).toBe("[<65;2;");
    expect(step.verdict).toBe("consumed");
  });

  test("a chunk that is only a growable prefix of a report is held while the key is plain", () => {
    for (const partial of ["[", "[<", "[<65", "[<65;16", "[<65;16;20"]) {
      const step = chunk("", partial);
      expect(step.hold).toBe(partial);
      expect(step.reports).toEqual([]);
      expect(step.verdict).toBe("consumed");
    }
  });

  test("a prefix chunk whose key is NOT plain is no longer held: a keypress decides it was typed", () => {
    // ESC/Enter/arrows mean the terminal sent a key, not the first half of a
    // report, so the hold must not swallow it.
    expect(chunk("", "[", { key: ESCAPE_KEY }).hold).toBeNull();
    expect(chunk("", "[", { key: RETURN_KEY }).hold).toBeNull();
    expect(plainKeyOf(ESCAPE_KEY)).toBe(false);
    expect(plainKeyOf(RETURN_KEY)).toBe(false);
    expect(plainKeyOf(NONE_KEY)).toBe(true);
  });

  test("a held bare '[' completes a report in the next chunk: the halves are joined, nothing restored", () => {
    const step = chunk("[", "<64;10;5M");
    expect(step.reports).toEqual([{ btn: 64, x: 10, y: 5, press: true }]);
    expect(step.restored).toBe("");
    expect(step.hold).toBeNull();
  });

  test("a held bare '[' followed by an ordinary key is RESTORED and the layer passes", () => {
    const step = chunk("[", "a");
    expect(step.reports).toEqual([]);
    expect(step.restored).toBe("[");
    expect(step.submit).toBe(false);
    expect(step.verdict).toBe("pass");
  });

  test("a held bare '[' plus Enter: restored AND submitted in the same event", () => {
    const step = chunk("[", "", { key: RETURN_KEY });
    expect(step.restored).toBe("[");
    expect(step.submit).toBe(true);
    // The layer still passes: the App runs the submit the carry asked for.
    expect(step.verdict).toBe("pass");
  });

  test("a longer truncated hold is DROPPED, never restored (it was not a typed bracket)", () => {
    const step = chunk("[<65;16;", "a");
    expect(step.restored).toBe("");
    expect(step.submit).toBe(false);
    expect(step.verdict).toBe("pass");
  });

  test("behind a panel the layer CONSUMES the chunk, restored bracket and all", () => {
    const step = chunk("[", "a", { panelOpen: true });
    expect(step.restored).toBe("");
    expect(step.swallowBehindPanel).toBe(true);
    expect(step.verdict).toBe("consumed");
    // A report is still dispatched with a panel open (the wheel scrolls the
    // transcript behind `/mcp`, and a panel row is clickable).
    expect(chunk("", "[<64;10;5M", { panelOpen: true }).verdict).toBe("consumed");
    expect(chunk("", "[<64;10;5M", { panelOpen: true }).reports).toHaveLength(1);
  });
});

// --- the per-report dispatch ---------------------------------------------

const LAID: readonly LaidItem[] = [
  { rows: ["◼ tool: read"], start: 0, id: "call-1", gap: false, toggleRows: 1 },
  { rows: ["a line", "another"], start: 2, id: "", gap: true, toggleRows: 1 },
];
const WIN = { start: 0, end: 3 };

const snapshot = (over: Partial<MouseSnapshot> = {}): MouseSnapshot => ({
  listView: null,
  panelOpen: false,
  columns: 80,
  panelBodyTop: 10,
  dockTop: null,
  dockView: null,
  statusRow: null,
  laid: LAID,
  win: WIN,
  total: 3,
  viewport: 3,
  visibleCount: 3,
  expandAll: false,
  artifactOf: () => undefined,
  ...over,
});

const state = (over: Partial<MouseState> = {}): MouseState => ({
  click: CLICK_IDLE,
  selection: null,
  ...over,
});

const kinds = (effects: readonly { readonly kind: string }[]) => effects.map((e) => e.kind);

describe("S4 dispatchMouse: the per-event priority order", () => {
  test("a wheel notch scrolls by WHEEL_LINES: 64 (up) towards the older rows, 65 (down) back", () => {
    const up = dispatchMouse(state(), report(64, 10, 5), snapshot());
    const down = dispatchMouse(state(), report(65, 10, 5), snapshot());
    // `scrollOffset` grows as the view moves UP the buffer (`hiddenAbove = win.start`).
    expect(up.effects).toEqual([{ kind: "scroll", delta: WHEEL_LINES }]);
    expect(down.effects).toEqual([{ kind: "scroll", delta: -WHEEL_LINES }]);
    // The wheel never arms a click or a selection.
    expect(up.state).toEqual(state());
  });

  test("the wheel is decided BEFORE a panel body row under the same cells", () => {
    const view = panelView();
    const snap = snapshot({ listView: view, panelBodyTop: 1 });
    // Row 1 is the panel's first body row; a wheel there still scrolls.
    expect(kinds(dispatchMouse(state(), report(64, 3, 1), snap).effects)).toEqual(["scroll"]);
    // A left PRESS there is the panel's.
    expect(kinds(dispatchMouse(state(), report(0, 3, 1), snap).effects)).toEqual(["panelClick"]);
  });

  test("a left press on a panel body row names its body index; a drag or a release there does nothing", () => {
    const snap = snapshot({ listView: panelView(), panelBodyTop: 10 });
    const press = dispatchMouse(state(), report(0, 3, 11), snap);
    expect(press.effects).toEqual([{ kind: "panelClick", bodyIndex: 1 }]);
    // Motion inside the body is not a click on it.
    expect(kinds(dispatchMouse(state(), report(32, 3, 11), snap).effects)).toEqual([]);
    // Neither is a release: the body branch returns for BOTH, so a release on a
    // panel row copies no selection (today's behaviour, kept).
    expect(kinds(dispatchMouse(state(), report(0, 3, 11, false), snap).effects)).toEqual([]);
    // Below the last body row the row is not the panel's any more.
    expect(kinds(dispatchMouse(state(), report(0, 3, 30), snap).effects)).not.toEqual([
      "panelClick",
    ]);
  });

  test("a press inside the pill's cells opens the dropdown; anywhere else on the bar it does not", () => {
    const snap = snapshot({ statusRow: { y: 20, pill: { start: 5, end: 9 } } });
    expect(kinds(dispatchMouse(state(), report(0, 6, 20), snap).effects)).toEqual(["dockPill"]);
    // The pill's range is (start, end]: the cell AT `start` is not the pill.
    expect(kinds(dispatchMouse(state(), report(0, 5, 20), snap).effects)).toEqual([]);
    expect(kinds(dispatchMouse(state(), report(0, 10, 20), snap).effects)).toEqual([]);
    // The right row, wrong row: no.
    expect(kinds(dispatchMouse(state(), report(0, 6, 19), snap).effects)).toEqual([]);
    // No pill painted (a bar without one): no hit, never a crash.
    expect(
      kinds(dispatchMouse(state(), report(0, 6, 20), snapshot({ statusRow: null })).effects),
    ).toEqual([]);
  });

  test("a press on a dock dropdown row opens THAT row; the rule row and beyond the last row do not", () => {
    const dock = dockView();
    const snap = snapshot({ dockTop: 15, dockView: dock });
    expect(dispatchMouse(state(), report(0, 4, 16), snap).effects).toEqual([
      { kind: "dockRow", id: "sa-1" },
    ]);
    expect(dispatchMouse(state(), report(0, 4, 17), snap).effects).toEqual([
      { kind: "dockRow", id: "sa-2" },
    ]);
    // The rule row itself is not a row.
    expect(kinds(dispatchMouse(state(), report(0, 4, 15), snap).effects)).toEqual([]);
    // Past the last row: nothing.
    expect(kinds(dispatchMouse(state(), report(0, 4, 18), snap).effects)).toEqual([]);
  });

  test("a press+release on a tool call's HEADER toggles it and clears the selection", () => {
    const armed = dispatchMouse(state(), report(0, 3, 1), snapshot());
    expect(armed.state.click.armed).toEqual({ x: 3, y: 1 });
    const clicked = dispatchMouse(armed.state, report(0, 3, 1, false), snapshot());
    expect(clicked.effects).toEqual([{ kind: "toggleTool", id: "call-1" }]);
    expect(clicked.state.selection).toBeNull();
  });

  test("with Ctrl+O on, a click has nothing to reveal: no toggle, and it stays a selection", () => {
    const armed = dispatchMouse(state({}), report(0, 3, 1), snapshot({ expandAll: true }));
    const clicked = dispatchMouse(
      armed.state,
      report(0, 3, 1, false),
      snapshot({ expandAll: true }),
    );
    expect(kinds(clicked.effects)).toEqual(["copySelection"]);
  });

  // docs/feat/tui-present-row.md: a `present` header with its card OPENS it.
  const ART = {
    artifactId: "a3",
    version: 1,
    sha256: "a".repeat(64),
    size: 593,
    mimeType: "text/html",
    kind: "html",
    title: "Latency report",
    callId: "call-1",
    createdAt: 1,
  };
  const click = (snap: MouseSnapshot, y = 1) => {
    const armed = dispatchMouse(state(), report(0, 3, y), snap);
    return dispatchMouse(armed.state, report(0, 3, y, false), snap);
  };

  test("a click on a header whose row carries an artifact opens THAT artifact, never toggles", () => {
    const asked: string[] = [];
    const snap = snapshot({
      artifactOf: (id) => {
        asked.push(id);
        return id === "call-1" ? ART : undefined;
      },
    });
    const clicked = click(snap);
    expect(clicked.effects).toEqual([{ kind: "openArtifact", artifact: ART }]);
    expect(clicked.state.selection).toBeNull();
    expect(asked).toEqual(["call-1"]);
  });

  test("with Ctrl+O on, a `present` header click still opens (nothing to expand there)", () => {
    const clicked = click(snapshot({ expandAll: true, artifactOf: () => ART }));
    expect(kinds(clicked.effects)).toEqual(["openArtifact"]);
  });

  test("a non-header row of the same transcript never opens (body/text rows stay text)", () => {
    // Row 3 is the plain item (`id: ""`): no call, so `artifactOf` is not asked.
    const clicked = click(
      snapshot({
        artifactOf: () => {
          throw new Error("asked for a non-call row");
        },
      }),
      3,
    );
    expect(kinds(clicked.effects)).toEqual(["copySelection"]);
  });

  test("a release COPIES the selection and hands back an empty one", () => {
    const sel = { anchor: { row: 0, col: 0 }, head: { row: 1, col: 2 } };
    const step = dispatchMouse(state({ selection: sel }), report(0, 3, 2, false), snapshot());
    expect(step.effects).toEqual([{ kind: "copySelection" }]);
    expect(step.state.selection).toBeNull();
  });

  test("a press starts a selection at the report's cell; a drag EXTENDS the same anchor", () => {
    const press = dispatchMouse(state(), report(0, 4, 2), snapshot());
    expect(press.state.selection).toEqual({ anchor: { row: 1, col: 3 }, head: { row: 1, col: 3 } });
    const drag = dispatchMouse(press.state, report(32, 9, 3), snapshot());
    expect(drag.state.selection).toEqual({
      anchor: { row: 1, col: 3 },
      head: { row: 2, col: 8 },
    });
    // A fresh press (no motion bit) restarts the selection at the new cell.
    const again = dispatchMouse(drag.state, report(0, 1, 1), snapshot());
    expect(again.state.selection).toEqual({ anchor: { row: 0, col: 0 }, head: { row: 0, col: 0 } });
  });

  test("a press outside the viewport (the input box, the status bar) selects nothing", () => {
    const below = dispatchMouse(state(), report(0, 4, 9), snapshot({ visibleCount: 3 }));
    expect(below.effects).toEqual([]);
    expect(below.state.selection).toBeNull();
  });

  test("a coalesced press+drag+release chunk is copied with NO render between the reports", () => {
    // The freshness property: each report's state is the previous report's, so a
    // release sees the selection the same chunk's press made (a render would
    // have been needed had the state lived in React state read per report).
    const snap = snapshot();
    let st = state();
    const seen: string[] = [];
    for (const r of [report(0, 3, 1), report(32, 6, 1), report(0, 6, 1, false)]) {
      const step = dispatchMouse(st, r, snap);
      seen.push(...kinds(step.effects));
      st = step.state;
    }
    expect(seen).toEqual(["copySelection"]);
    expect(st.selection).toBeNull();
  });
});

/** The panel's view-model: two body rows is all this hit test reads. */
function panelView(): PanelView {
  return {
    title: "mcp",
    rows: [
      { text: "row 0", kind: "head", selected: false },
      { text: "row 1", kind: "child", selected: false },
    ],
    hint: "esc close",
    start: 0,
  };
}

/** The dock's dropdown: two clickable rows (the ids are wire ids). */
function dockView(): BackgroundListView {
  return {
    label: "background",
    count: 2,
    rule: [],
    rows: [{ id: "sa-1" }, { id: "sa-2" }] as unknown as BackgroundListView["rows"],
    start: 0,
    above: 0,
    below: 0,
    hint: "",
    focused: true,
  };
}

describe("S4 sliceLaid: the release assembles the WHOLE buffer, not just the window", () => {
  test("a selection spanning scrolled-out rows is fully materialised on release", () => {
    // `dispatchMouse` asks for `copySelection` only; the App answers it with
    // `sliceLaid(laid, 0, total)` — every row, never the visible window.
    const rows = sliceLaid(LAID, 0, 3);
    expect(rows).toEqual(["◼ tool: read", "", "a line"]);
  });
});
