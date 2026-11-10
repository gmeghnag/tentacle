/**
 * feat/subagent-panel (task 7): the dock's focus machine and key routing
 * (AGENTS §7 — App only executes what this returns; it decides nothing).
 *
 * The DOWN table is the whole subtlety: DOWN keeps today's three meanings in
 * order (the palette, a line below the cursor, a history walk) and only then
 * walks into the dock — so a multi-line draft still edits, and a history walk
 * still walks, exactly as before. Since the UI revision DOWN lands on the PILL
 * (docs/feat/subagent-panel.md), and the Esc chain is drawer → dropdown → pill →
 * input.
 */
import { describe, expect, test } from "bun:test";
import {
  type DockState,
  INPUT_DOCK,
  clickDock,
  closeOpen,
  closeToDropdown,
  dockKey,
  dockKindOf,
  downEntersList,
  noteSent,
  openChild,
  openDropdown,
  reconcile,
  refusalPlacement,
  sendTarget,
  toggleList,
} from "../src/background-focus.ts";

const key = (k: Partial<Record<string, boolean>> = {}, char = "") => ({ char, key: k });

describe("T-F1: the DOWN table", () => {
  test("noteSent keeps a message's index (and clears the draft), with or without an `n`", () => {
    // docs/fix/autoaccept-wake-turns.md part B: the drawer needs the message's
    // own index to say `✓ read`. MUTATION: drop the `n` argument → the `✓ read`
    // frame test goes red (no index to compare).
    const withIndex = noteSent(INPUT_DOCK, "sa-1", "hi", 2);
    expect(withIndex.sent["sa-1"]).toEqual([{ text: "hi", n: 2 }]);
    expect(withIndex.drafts["sa-1"]).toBe("");
    // An older daemon sends no index: the text alone, and nothing invented.
    const withoutIndex = noteSent(INPUT_DOCK, "sa-1", "hi");
    expect(withoutIndex.sent["sa-1"]).toEqual([{ text: "hi" }]);
    // The last 3 keep their own indexes, in order.
    const three = noteSent(
      noteSent(noteSent(INPUT_DOCK, "sa-1", "a", 1), "sa-1", "b", 2),
      "sa-1",
      "c",
    );
    expect(three.sent["sa-1"]).toEqual([{ text: "a", n: 1 }, { text: "b", n: 2 }, { text: "c" }]);
  });
  const base = {
    action: "history" as const,
    onDraftSlot: true,
    paletteOpen: false,
    visible: true,
    focus: INPUT_DOCK.focus,
  };

  test("on the draft slot, last line, nothing else owning DOWN → focus the pill", () => {
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

describe("T-F2: the pill's and the dropdown's own keys", () => {
  const three = ["sa-1", "sa-2", "sa-3"];
  const ctx = { ids: three, openable: (id: string) => id.startsWith("sa-"), draft: "" };
  const step = (state: DockState, char = "", k: Record<string, boolean> = {}) =>
    dockKey(state, char, k, ctx);
  /** DOWN from the input → the pill → Enter → the dropdown (the whole chain). */
  const atList = () => openDropdown(toggleList(INPUT_DOCK, three), three);

  test("DOWN focuses the pill; Enter opens the dropdown on its FIRST row", () => {
    // The owner's DOWN table: DOWN now points at the pill (it is the bottom-most
    // control), and the dropdown is one Enter further.
    const pill = toggleList(INPUT_DOCK, three);
    expect(pill.focus).toEqual({ kind: "pill" });
    const drop = dockKey(pill, "", { return: true }, ctx).state;
    expect(drop.focus).toEqual({ kind: "list", selected: "sa-1", armed: false });
    // ↓ on the pill points the same way as Enter (a dropdown opens downward).
    expect(dockKey(pill, "", { downArrow: true }, ctx).state.focus).toMatchObject({
      kind: "list",
      selected: "sa-1",
    });
  });

  test("Esc on the pill is back on the input, effect `none` (never the turn's abort)", () => {
    const pill = toggleList(INPUT_DOCK, three);
    const esc = step(pill, "", { escape: true });
    expect(esc.state.focus).toEqual({ kind: "input" });
    expect(esc.effect).toEqual({ kind: "none" });
    // ↑ walks back the same way.
    expect(step(pill, "", { upArrow: true }).state.focus).toEqual({ kind: "input" });
    // Ctrl+T is still the direct toggle.
    expect(step(pill, "t", { ctrl: true }).state.focus).toEqual({ kind: "input" });
  });

  test("a printable key on the pill goes BACK to the input and is typed there (owner P3 a)", () => {
    const pill = toggleList(INPUT_DOCK, three);
    const typed = step(pill, "a");
    expect(typed.state.focus).toEqual({ kind: "input" });
    expect(typed.effect).toEqual({ kind: "pass" });
  });

  test("the ESC CHAIN: the dropdown's Esc lands on the pill, not the input", () => {
    // The plan's mutation: make this return `input` → the chain skips a step and
    // a second Esc is needed where the design says one.
    const esc = step(atList(), "", { escape: true });
    expect(esc.state.focus).toEqual({ kind: "pill" });
    expect(esc.effect).toEqual({ kind: "none" });
    // ↑ from the first row is the same step (there is nothing above it).
    expect(step(atList(), "", { upArrow: true }).state.focus).toEqual({ kind: "pill" });
  });

  test("the ESC CHAIN, the whole way: drawer → dropdown → pill → input", () => {
    // One key per step, in the design's order, and the input ends up with its
    // main draft back (the drawer's close effect swaps them).
    const drawer = openChild(atList(), "sa-1", "MAIN").state;
    expect(drawer.focus).toMatchObject({ kind: "open", id: "sa-1" });
    const toDrop = dockKey(drawer, "", { escape: true }, { ...ctx, draft: "CHILD" });
    expect(toDrop.state.focus).toMatchObject({ kind: "list", selected: "sa-1" });
    expect(toDrop.effect).toEqual({ kind: "close", draftOut: "CHILD", draftIn: "MAIN" });
    const toPill = dockKey(toDrop.state, "", { escape: true }, ctx);
    expect(toPill.state.focus).toEqual({ kind: "pill" });
    const toInput = dockKey(toPill.state, "", { escape: true }, ctx);
    expect(toInput.state.focus).toEqual({ kind: "input" });
  });

  test("↓ on the last row stays (no wrap); ↑ on the second row moves up", () => {
    const second = dockKey(atList(), "", { downArrow: true }, ctx).state;
    expect(second.focus).toMatchObject({ selected: "sa-2" });
    const third = step(second, "", { downArrow: true }).state;
    expect(third.focus).toMatchObject({ selected: "sa-3" });
    expect(step(third, "", { downArrow: true }).state.focus).toMatchObject({ selected: "sa-3" });
    expect(step(third, "", { upArrow: true }).state.focus).toMatchObject({ selected: "sa-2" });
  });

  test("`x` then `y` stops; `x` then anything else disarms AND is swallowed", () => {
    const at = atList();
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

  test("a printable key with the dropdown focused is IGNORED (owner P3 (a))", () => {
    const at = atList();
    for (const char of ["a", "z", "1", " "]) {
      const r = step(at, char);
      expect(r.state).toBe(at);
      expect(r.effect).toEqual({ kind: "none" });
    }
  });

  test("Enter opens the selected child and swaps the drafts", () => {
    const withDrafts: DockState = { ...INPUT_DOCK, drafts: { main: "half typed" } };
    const at = openDropdown(toggleList(withDrafts, three), three);
    // The live field is the source of the draft that goes out (Review H1).
    const opened = dockKey(at, "", { return: true }, { ...ctx, draft: "half typed" });
    expect(opened.effect).toEqual({
      kind: "open",
      id: "sa-1",
      draftOut: "half typed",
      draftIn: "",
    });
    expect(opened.state.focus).toMatchObject({ kind: "open", id: "sa-1" });
  });

  test("Enter stashes the LIVE field, not a state copy (Review H1)", () => {
    // The App never writes `field.value` into `drafts`; it hands it to the module
    // in the key context. Reading `drafts.main` instead loses the user's text.
    const live: DockState = { ...INPUT_DOCK, drafts: {} };
    const opened = dockKey(
      openDropdown(toggleList(live, three), three),
      "",
      { return: true },
      {
        ...ctx,
        draft: "MAINDRAFT",
      },
    );
    expect(opened.effect).toEqual({
      kind: "open",
      id: "sa-1",
      draftOut: "MAINDRAFT",
      draftIn: "",
    });
    expect(opened.state.drafts.main).toBe("MAINDRAFT");
  });
});

describe("T-F3: open / close swap drafts per target; sendTarget's rules", () => {
  const three = ["sa-1", "sa-2", "sa-3"];
  const ctx = { ids: three, openable: (id: string) => id.startsWith("sa-"), draft: "" };

  test("each target keeps its own draft, and the main one comes back", () => {
    let state: DockState = { ...INPUT_DOCK, drafts: { main: "main text" } };
    state = openChild(state, "sa-1", "main text").state;
    expect(state.focus).toMatchObject({ kind: "open", id: "sa-1" });
    // Type into sa-1's draft.
    state = { ...state, drafts: { ...state.drafts, "sa-1": "to sa-1" } };
    const closed = closeOpen(state, "to sa-1");
    expect(closed.state.focus).toEqual({ kind: "input" });
    expect(closed.effect).toEqual({ kind: "close", draftOut: "to sa-1", draftIn: "main text" });
    expect(closed.state.drafts).toMatchObject({ main: "main text", "sa-1": "to sa-1" });
    // Re-opening restores sa-1's own draft.
    const reopened = openChild(closed.state, "sa-1", "main text");
    expect(reopened.effect).toMatchObject({ draftIn: "to sa-1" });
  });

  test("sendTarget: the input sends to the agent; an open target to it; an ended one is refused", () => {
    expect(sendTarget(INPUT_DOCK, "hello")).toEqual({ kind: "main" });
    const open = openChild(INPUT_DOCK, "sa-1", "").state;
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
    const open = openChild(INPUT_DOCK, "sa-1", "").state;
    expect(sendTarget(open, "/clear")).toEqual({ kind: "main" });
    // …and a draft of whitespace is not a message at all.
    expect(sendTarget(open, "   ")).toEqual({ kind: "main" });
  });

  test("Esc stashes the CHILD's live text and gives the main one back (Review H1)", () => {
    // Same flaw on the way out: `drafts[id]` is whatever was stashed at open
    // (empty), so the child's text typed since must come from the live field.
    const open: DockState = {
      focus: { kind: "open", id: "sa-1", ended: null, frozen: null },
      drafts: { main: "MAINDRAFT", "sa-1": "" },
      sent: {},
    };
    const ctxWithDraft = { ids: ["sa-1"], openable: () => true, draft: "CHILDDRAFT" };
    const closed = dockKey(open, "", { escape: true }, ctxWithDraft);
    expect(closed.effect).toEqual({ kind: "close", draftOut: "CHILDDRAFT", draftIn: "MAINDRAFT" });
    expect(closed.state.drafts).toMatchObject({ main: "MAINDRAFT", "sa-1": "CHILDDRAFT" });
  });

  test("Esc in `open` closes (never stops the turn) and the ended drawer closes too", () => {
    const open = openChild(INPUT_DOCK, "sa-1", "").state;
    // Esc's first step is the DROPDOWN when there is still a list to show (the
    // Esc chain), and the input when there is not.
    const esc = dockKey(open, "", { escape: true }, ctx);
    expect(esc.effect.kind).toBe("close");
    expect(esc.state.focus).toMatchObject({ kind: "list", selected: "sa-1" });
    const alone = dockKey(open, "", { escape: true }, { ...ctx, ids: [] });
    expect(alone.state.focus).toEqual({ kind: "input" });
    const ended: DockState = {
      focus: { kind: "open", id: "sa-1", ended: { kind: "stopped" }, frozen: null },
      drafts: {},
      sent: {},
    };
    const closedEnded = dockKey(ended, "", { escape: true }, { ...ctx, ids: [] });
    expect(closedEnded.effect.kind).toBe("close");
    expect(closedEnded.state.focus).toEqual({ kind: "input" });
  });

  test("every other key in `open` is `pass`: the input keeps editing, as today", () => {
    const open = openChild(INPUT_DOCK, "sa-1", "").state;
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

describe("T-F5: where a late refusal's text goes (Review H2)", () => {
  const openOn = (id: string): DockState => ({
    focus: { kind: "open", id, ended: null, frozen: null },
    drafts: {},
    sent: {},
  });

  test("still open on that child, field empty → the field takes it", () => {
    expect(refusalPlacement(openOn("sa-1"), "sa-1", "")).toBe("field");
  });

  test("still open but the user typed since → never an overwrite", () => {
    expect(refusalPlacement(openOn("sa-1"), "sa-1", "typed since")).toBe("notice");
  });

  test("closed (the reviewer's case) → NEVER the main field, the notice quotes it", () => {
    expect(refusalPlacement(INPUT_DOCK, "sa-1", "")).toBe("notice");
  });

  test("back on the list, or another child open → never the field", () => {
    expect(refusalPlacement(openOn("sa-2"), "sa-1", "")).toBe("notice");
    expect(
      refusalPlacement(
        { ...INPUT_DOCK, focus: { kind: "list", selected: "sa-1", armed: false } },
        "sa-1",
        "",
      ),
    ).toBe("notice");
  });

  test("a CLICK: on the pill the dropdown opens at once; on a row that child opens", () => {
    // The mockups' mouse rule, decided here so the App only routes the report.
    const three = ["sa-1", "sa-2", "sa-3"];
    const clickedPill = clickDock(INPUT_DOCK, { kind: "pill" }, three);
    expect(clickedPill.state.focus).toEqual({ kind: "list", selected: "sa-1", armed: false });
    const clickedRow = clickDock(clickedPill.state, { kind: "row", id: "sa-2" }, three);
    expect(clickedRow.state.focus).toMatchObject({ kind: "open", id: "sa-2" });
    expect(clickedRow.effect).toEqual({ kind: "open", id: "sa-2", draftOut: "", draftIn: "" });
    // With nothing in the background the pill is not there to click.
    expect(clickDock(INPUT_DOCK, { kind: "pill" }, []).state).toBe(INPUT_DOCK);
  });

  test("Esc's own stash is never treated as a place to hide text", () => {
    // `drafts[id]` may already hold what the user left there: the placement must
    // not depend on it, or a later Esc would overwrite it (a silent drop).
    const stashed: DockState = { ...openOn("sa-1"), drafts: { main: "M", "sa-1": "earlier" } };
    expect(refusalPlacement(stashed, "sa-1", "typed")).toBe("notice");
  });
});

describe("T-F4: reconcile", () => {
  const three = ["sa-1", "sa-2", "sa-3"];
  const ctx = { ids: three, openable: () => true, draft: "" };

  test("the selected child leaves → the row that took its place, else the one above", () => {
    const at = dockKey(
      openDropdown(toggleList(INPUT_DOCK, three), three),
      "",
      { downArrow: true },
      ctx,
    ).state;
    expect(at.focus).toMatchObject({ selected: "sa-2" });
    // sa-2 leaves: the row that took its place is sa-3.
    expect(reconcile(at, ["sa-1", "sa-3"], []).focus).toMatchObject({ selected: "sa-3" });
    // sa-3 (the last) leaves: the one above.
    const atLast = { ...at, focus: { kind: "list" as const, selected: "sa-3", armed: false } };
    expect(reconcile(atLast, ["sa-1", "sa-2"], []).focus).toMatchObject({ selected: "sa-2" });
  });

  test("the last row leaves → back to the input, the draft untouched; a focused pill follows it too", () => {
    const at: DockState = {
      focus: { kind: "list", selected: "sa-1", armed: false },
      drafts: { main: "keep me" },
      sent: {},
    };
    const after = reconcile(at, [], []);
    expect(after.focus).toEqual({ kind: "input" });
    expect(after.drafts.main).toBe("keep me");
    // The pill is only a control for the list: with nothing left it has no job,
    // so it gives the input back rather than lingering over an empty panel.
    const pill: DockState = { focus: { kind: "pill" }, drafts: { main: "keep me" }, sent: {} };
    expect(reconcile(pill, [], []).focus).toEqual({ kind: "input" });
    expect(reconcile(pill, ["sa-1"], []).focus).toEqual({ kind: "pill" });
  });

  test("an open child ends → its drawer freezes and its target is marked, never re-routed", () => {
    const open = openChild(INPUT_DOCK, "sa-1", "").state;
    const after = reconcile(open, [], [{ id: "sa-1", outcome: { kind: "finished" } }]);
    expect(after.focus).toMatchObject({ kind: "open", id: "sa-1", ended: { kind: "finished" } });
    // A later report without it does not unfreeze it.
    expect(reconcile(after, [], []).focus).toMatchObject({ ended: { kind: "finished" } });
  });

  test("an open child still running is untouched by an unrelated end", () => {
    const open = openChild(INPUT_DOCK, "sa-1", "").state;
    const after = reconcile(open, ["sa-1", "sa-2"], [{ id: "sa-2", outcome: { kind: "stopped" } }]);
    expect(after.focus).toMatchObject({ kind: "open", id: "sa-1", ended: null });
  });
});

describe("T-F5: a shell job in the dock (docs/feat/shell-jobs-panel.md)", () => {
  const job = { id: "bg-3", command: "watch", startedAt: 0 };
  const ids = ["sa-1", "bg-3"];
  const ctx = {
    ids,
    openable: (id: string) => id.startsWith("sa-") || id.startsWith("bg-"),
    draft: "",
  };

  test("`dockKindOf` reads the wire id, and nothing else", () => {
    expect(dockKindOf("bg-3")).toBe("job");
    expect(dockKindOf("sa-1")).toBe("agent");
    // A foreign id is a child's: the safe default (it never kills a job).
    expect(dockKindOf("watch-9")).toBe("agent");
  });

  test("Enter on a job row opens it, with the REAL wire id", () => {
    const open = openDropdown(toggleList(INPUT_DOCK, ids), ids);
    const at = dockKey(open, "", { downArrow: true }, ctx).state;
    expect(at.focus).toMatchObject({ kind: "list", selected: "bg-3" });
    const step = dockKey(at, "", { return: true }, ctx);
    expect(step.effect).toEqual({ kind: "open", id: "bg-3", draftOut: "", draftIn: "" });
    expect(step.state.focus).toMatchObject({ kind: "open", id: "bg-3" });
  });

  test("typing with a job's drawer open stays on the MAIN agent (owner Q1 (a))", () => {
    const open = openChild(INPUT_DOCK, "bg-3", "").state;
    expect(sendTarget(open, "carry on")).toEqual({ kind: "main" });
    // Even after it ended: a job has no inbox to refuse either.
    const ended = reconcile(open, [], [{ id: "bg-3", outcome: { kind: "finished" } }]);
    expect(sendTarget(ended, "carry on")).toEqual({ kind: "main" });
    // A child's is unchanged: it goes to the child, and refuses once ended.
    expect(sendTarget(openChild(INPUT_DOCK, "sa-1", "").state, "hi")).toEqual({
      kind: "agent",
      id: "sa-1",
    });
  });

  test("x then y on a job row is a stop with the real id", () => {
    const at = dockKey(
      openDropdown(toggleList(INPUT_DOCK, ids), ids),
      "",
      { downArrow: true },
      ctx,
    ).state;
    const armed = dockKey(at, "x", {}, ctx).state;
    expect(armed.focus).toMatchObject({ kind: "list", selected: "bg-3", armed: true });
    expect(dockKey(armed, "y", {}, ctx).effect).toEqual({ kind: "stop", id: "bg-3" });
  });

  test("an open job that leaves the list freezes on its LAST row, its focus kept", () => {
    const open = openChild(INPUT_DOCK, "bg-3", "").state;
    // The frame drops it, with the exit's outcome and the row it had.
    const after = reconcile(
      open,
      ["sa-1"],
      [{ id: "bg-3", outcome: { kind: "finished" } }],
      [{ kind: "job", row: job }],
    );
    expect(after.focus).toMatchObject({ kind: "open", id: "bg-3", ended: { kind: "finished" } });
    const frozen = after.focus.kind === "open" ? after.focus.frozen : null;
    // The command and the clock survive, so the drawer keeps painting them.
    expect(frozen).toEqual({ kind: "job", row: job });
    // No re-route: the input's draft is untouched.
    expect(after.drafts).toEqual(open.drafts);
    // A later report without it does not unfreeze it either.
    const later = reconcile(after, ["sa-1"], []);
    expect(later.focus).toMatchObject({ ended: { kind: "finished" } });
    expect(later.focus.kind === "open" ? later.focus.frozen : null).toEqual({
      kind: "job",
      row: job,
    });
  });

  test("a live job keeps its drawer's subject from the list (no freeze needed)", () => {
    const open = openChild(INPUT_DOCK, "bg-3", "").state;
    const after = reconcile(open, ["bg-3"], [], [{ kind: "job", row: job }]);
    expect(after.focus.kind === "open" ? after.focus.frozen : null).toEqual({
      kind: "job",
      row: job,
    });
  });
});
