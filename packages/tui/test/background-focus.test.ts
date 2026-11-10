/**
 * feat/subagent-panel (task 7): the dock's focus machine and key routing
 * (AGENTS §7 — App only executes what this returns; it decides nothing).
 *
 * The DOWN table (mockup 02) is the whole subtlety: DOWN keeps today's three
 * meanings in order (the palette, a line below the cursor, a history walk) and
 * only then walks into the list — so a multi-line draft still edits, and a
 * history walk still walks, exactly as before.
 */
import { describe, expect, test } from "bun:test";
import {
  type DockState,
  INPUT_DOCK,
  closeOpen,
  dockKey,
  downEntersList,
  openChild,
  reconcile,
  sendTarget,
  toggleList,
} from "../src/background-focus.ts";

const key = (k: Partial<Record<string, boolean>> = {}, char = "") => ({ char, key: k });

describe("T-F1: the DOWN table", () => {
  const base = {
    action: "history" as const,
    onDraftSlot: true,
    paletteOpen: false,
    visible: true,
    focus: INPUT_DOCK.focus,
  };

  test("on the draft slot, last line, nothing else owning DOWN → enter the list", () => {
    expect(downEntersList(base)).toBe(true);
  });

  test("a line below the cursor keeps moving (a multi-line buffer edits)", () => {
    expect(downEntersList({ ...base, action: "moveVertical" })).toBe(false);
  });

  test("mid-history keeps walking history (the plan's mutation: drop `onDraftSlot` → red)", () => {
    // Inside a history walk, DOWN never enters the list: the user is recalling
    // an entry, and the dock would swallow the rest of the walk.
    expect(downEntersList({ ...base, onDraftSlot: false })).toBe(false);
  });

  test("the palette owns DOWN while it is open", () => {
    expect(downEntersList({ ...base, paletteOpen: true })).toBe(false);
  });

  test("an empty list is nothing to enter", () => {
    expect(downEntersList({ ...base, visible: false })).toBe(false);
  });

  test("with a child open (the drawer shown, the list hidden) DOWN does nothing", () => {
    expect(
      downEntersList({
        ...base,
        focus: { kind: "open", id: "sa-1", ended: null, frozen: null },
      }),
    ).toBe(false);
  });
});

describe("T-F2: the list's own keys", () => {
  const three = ["sa-1", "sa-2", "sa-3"];
  const ctx = { ids: three, openable: (id: string) => id.startsWith("sa-") };
  const step = (state: DockState, char = "", k: Record<string, boolean> = {}) =>
    dockKey(state, char, k, ctx);

  test("↑ from the first row returns to the input with no effect on the turn", () => {
    const at = toggleList(INPUT_DOCK, three);
    expect(at.focus).toEqual({ kind: "list", selected: "sa-1", armed: false });
    const up = step(at, "", { upArrow: true });
    expect(up.state.focus).toEqual({ kind: "input" });
    expect(up.effect.kind).toBe("none");
  });

  test("Esc returns to the input and NEVER stops the turn (its effect is `none`)", () => {
    // The mutation the plan names: let the App's Esc-stops-turn branch see it →
    // an Esc meant to leave the list aborts a running turn.
    const at = toggleList(INPUT_DOCK, three);
    const esc = step(at, "", { escape: true });
    expect(esc.state.focus).toEqual({ kind: "input" });
    expect(esc.effect).toEqual({ kind: "none" });
    // Ctrl+T is the same toggle back.
    const ctrlT = step(at, "t", { ctrl: true });
    expect(ctrlT.state.focus).toEqual({ kind: "input" });
  });

  test("↓ on the last row stays (no wrap); ↑ on the second row moves up", () => {
    const second = dockKey(toggleList(INPUT_DOCK, three), "", { downArrow: true }, ctx).state;
    expect(second.focus).toMatchObject({ selected: "sa-2" });
    const third = step(second, "", { downArrow: true }).state;
    expect(third.focus).toMatchObject({ selected: "sa-3" });
    expect(step(third, "", { downArrow: true }).state.focus).toMatchObject({ selected: "sa-3" });
    expect(step(third, "", { upArrow: true }).state.focus).toMatchObject({ selected: "sa-2" });
  });

  test("`x` then `y` stops; `x` then anything else disarms AND is swallowed", () => {
    const at = toggleList(INPUT_DOCK, three);
    const armed = step(at, "x");
    expect(armed.state.focus).toMatchObject({ armed: true });
    expect(armed.effect.kind).toBe("none");
    const stopped = step(armed.state, "y");
    expect(stopped.effect).toEqual({ kind: "stop", id: "sa-1" });
    expect(stopped.state.focus).toMatchObject({ armed: false });
    // Any other key disarms and does nothing else — never typed into the input.
    const cancelled = step(armed.state, "q");
    expect(cancelled.state.focus).toMatchObject({ armed: false, selected: "sa-1" });
    expect(cancelled.effect).toEqual({ kind: "none" });
  });

  test("a printable key with the list focused is IGNORED (owner P3 (a))", () => {
    const at = toggleList(INPUT_DOCK, three);
    for (const char of ["a", "z", "1", " "]) {
      const r = step(at, char);
      expect(r.state).toBe(at);
      expect(r.effect).toEqual({ kind: "none" });
    }
  });

  test("Enter opens the selected child and swaps the drafts", () => {
    const withDrafts: DockState = { ...INPUT_DOCK, drafts: { main: "half typed" } };
    const at = toggleList(withDrafts, three);
    const opened = step(at, "", { return: true });
    expect(opened.effect).toEqual({
      kind: "open",
      id: "sa-1",
      draftOut: "half typed",
      draftIn: "",
    });
    expect(opened.state.focus).toMatchObject({ kind: "open", id: "sa-1" });
  });
});

describe("T-F3: open / close swap drafts per target; sendTarget's rules", () => {
  const three = ["sa-1", "sa-2", "sa-3"];
  const ctx = { ids: three, openable: (id: string) => id.startsWith("sa-") };

  test("each target keeps its own draft, and the main one comes back", () => {
    let state: DockState = { ...INPUT_DOCK, drafts: { main: "main text" } };
    state = openChild(state, "sa-1").state;
    expect(state.focus).toMatchObject({ kind: "open", id: "sa-1" });
    // Type into sa-1's draft.
    state = { ...state, drafts: { ...state.drafts, "sa-1": "to sa-1" } };
    const closed = closeOpen(state);
    expect(closed.state.focus).toEqual({ kind: "input" });
    expect(closed.effect).toEqual({ kind: "close", draftOut: "to sa-1", draftIn: "main text" });
    expect(closed.state.drafts).toMatchObject({ main: "main text", "sa-1": "to sa-1" });
    // Re-opening restores sa-1's own draft.
    const reopened = openChild(closed.state, "sa-1");
    expect(reopened.effect).toMatchObject({ draftIn: "to sa-1" });
  });

  test("sendTarget: the input sends to the agent; an open target to it; an ended one is refused", () => {
    expect(sendTarget(INPUT_DOCK, "hello")).toEqual({ kind: "main" });
    const open = openChild(INPUT_DOCK, "sa-1").state;
    expect(sendTarget(open, "hello")).toEqual({ kind: "agent", id: "sa-1" });
    const ended: DockState = {
      focus: { kind: "open", id: "sa-1", ended: { kind: "finished" }, frozen: null },
      drafts: {},
      sent: {},
    };
    const refused = sendTarget(ended, "hello");
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.text).toContain("sa-1");
      expect(refused.text).toContain("finished");
    }
  });

  test("a `/…` command goes to the main agent, never to the child", () => {
    const open = openChild(INPUT_DOCK, "sa-1").state;
    expect(sendTarget(open, "/clear")).toEqual({ kind: "main" });
    // …and a draft of whitespace is not a message at all.
    expect(sendTarget(open, "   ")).toEqual({ kind: "main" });
  });

  test("Esc in `open` closes (never stops the turn) and the ended drawer closes too", () => {
    const open = openChild(INPUT_DOCK, "sa-1").state;
    const esc = dockKey(open, "", { escape: true }, ctx);
    expect(esc.effect.kind).toBe("close");
    const ended: DockState = {
      focus: { kind: "open", id: "sa-1", ended: { kind: "stopped" }, frozen: null },
      drafts: {},
      sent: {},
    };
    const closedEnded = dockKey(ended, "", { escape: true }, ctx);
    expect(closedEnded.effect.kind).toBe("close");
    expect(closedEnded.state.focus).toEqual({ kind: "input" });
  });

  test("every other key in `open` is `pass`: the input keeps editing, as today", () => {
    const open = openChild(INPUT_DOCK, "sa-1").state;
    for (const [char, k] of [
      ["a", {}],
      ["", { backspace: true }],
      ["", { leftArrow: true }],
      ["", { pageUp: true }],
    ] as const) {
      const r = dockKey(open, char, k as Record<string, boolean>, ctx);
      expect(r.effect).toEqual({ kind: "pass" });
      expect(r.state).toBe(open);
    }
  });
});

describe("T-F4: reconcile", () => {
  const three = ["sa-1", "sa-2", "sa-3"];
  const ctx = { ids: three, openable: () => true };

  test("the selected child leaves → the row that took its place, else the one above", () => {
    const at = dockKey(toggleList(INPUT_DOCK, three), "", { downArrow: true }, ctx).state;
    expect(at.focus).toMatchObject({ selected: "sa-2" });
    // sa-2 leaves: the row that took its place is sa-3.
    expect(reconcile(at, ["sa-1", "sa-3"], []).focus).toMatchObject({ selected: "sa-3" });
    // sa-3 (the last) leaves: the one above.
    const atLast = { ...at, focus: { kind: "list" as const, selected: "sa-3", armed: false } };
    expect(reconcile(atLast, ["sa-1", "sa-2"], []).focus).toMatchObject({ selected: "sa-2" });
  });

  test("the last row leaves → back to the input, the draft untouched", () => {
    const at: DockState = {
      focus: { kind: "list", selected: "sa-1", armed: false },
      drafts: { main: "keep me" },
      sent: {},
    };
    const after = reconcile(at, [], []);
    expect(after.focus).toEqual({ kind: "input" });
    expect(after.drafts.main).toBe("keep me");
  });

  test("an open child ends → its drawer freezes and its target is marked, never re-routed", () => {
    const open = openChild(INPUT_DOCK, "sa-1").state;
    const after = reconcile(open, [], [{ id: "sa-1", outcome: { kind: "finished" } }]);
    expect(after.focus).toMatchObject({ kind: "open", id: "sa-1", ended: { kind: "finished" } });
    // A later report without it does not unfreeze it.
    expect(reconcile(after, [], []).focus).toMatchObject({ ended: { kind: "finished" } });
  });

  test("an open child still running is untouched by an unrelated end", () => {
    const open = openChild(INPUT_DOCK, "sa-1").state;
    const after = reconcile(open, ["sa-1", "sa-2"], [{ id: "sa-2", outcome: { kind: "stopped" } }]);
    expect(after.focus).toMatchObject({ kind: "open", id: "sa-1", ended: null });
  });
});
