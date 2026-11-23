/**
 * docs/feat/app-decomposition.md S10 — `app-layout.ts`, the frame's view-model,
 * unit-tested as a PURE function (AGENTS §7: the computation leaves the
 * component and is tested where it lives, without mounting Ink).
 *
 * The rows are a MOVE: each expectation is the arithmetic `App.tsx` carried
 * inline, so these cases pin the frame's geometry independently of the tree —
 * which is exactly the gap the S0 review named ("the frame set's `norm`
 * collapses rules, so it cannot see box geometry"; S10 must not rely on it).
 *
 * The cases are the plan's failure modes for this slice plus the boundaries the
 * inline code had to get right: the transcript's floor, the reserved rows, a
 * permission prompt replacing the bottom area (dock 0), the drawer's budget on a
 * short terminal (Review 4), an empty draft's attach row, the palette window, and
 * a measured/absent context fill.
 */
import { describe, expect, test } from "bun:test";
import { type FrameInput, frameLayout } from "../src/app-layout.ts";
import { NO_APPROVAL_SCROLL } from "../src/approval-scroll.ts";
import type { DockState } from "../src/background-focus.ts";
import { skillsPanel } from "../src/panel.ts";
import type { PermissionController } from "../src/permission-ui.ts";
import type { DisplayState } from "../src/state.ts";
import { panelHeight } from "../src/tree-panel.ts";

/** The rows a panel occupies (the same call `frameLayout` makes). */
const panelHeightOf = (frame: ReturnType<typeof frameLayout>): number =>
  frame.listView === null ? 0 : panelHeight(frame.listView);

/** A real attachment chip (`{ path, ref, bytes }` — the shape `chipLabel` reads). */
const CHIP = {
  path: "/tmp/a.png",
  ref: { id: "sha256-a", mimeType: "image/png", size: 10, name: "a.png" },
  bytes: new Uint8Array([1, 2, 3]),
};

/** A minimal idle transcript state. */
const idleState = (over: Partial<DisplayState> = {}): DisplayState =>
  ({
    items: [],
    running: false,
    reasoning: false,
    turnStartedAt: null,
    reasoningStartedAt: null,
    sessionTokens: null,
    lastTurnTokens: null,
    ...over,
  }) as DisplayState;

/** The dock at rest: focus on the input, nothing typed, nothing sent. */
const IDLE_DOCK: DockState = { focus: { kind: "input" }, drafts: {}, sent: {} };

/** A permission controller with nothing pending (the frame's default branch). */
const noPermission = (over: Partial<PermissionController> = {}): PermissionController =>
  ({
    pending: null,
    pendingAgent: null,
    choices: [],
    selected: 0,
    setSelected: () => {},
    answer: () => {},
    autoApprove: false,
    toggleAutoApprove: () => {},
    clearAutoApprove: () => {},
    mode: { mode: "menu" },
    setMode: () => {},
    readMode: () => ({ mode: "menu" }),
    // A ref read the layout makes for a `workflow_approve`'s window (the list is
    // scrolled, never cut); at rest it is the top of the list.
    approvalScroll: () => NO_APPROVAL_SCROLL,
    ...over,
  }) as unknown as PermissionController;

/** The frame's input with the smallest values that produce a real frame. */
const base = (over: Partial<FrameInput> = {}): FrameInput => ({
  state: idleState(),
  permission: noPermission(),
  dock: IDLE_DOCK,
  dockNow: 1_000,
  subagents: undefined,
  subagentsRef: { current: undefined },
  jobRows: undefined,
  jobRowsRef: { current: undefined },
  scheduleRows: undefined,
  drawerRow: null,
  drawerJob: null,
  jobOutput: {},
  dockFinished: null,
  quitConfirm: null,
  artifactConfirm: null,
  panel: null,
  sessionId: "s-1",
  field: { value: "", cursor: 0 },
  attach: { chips: [], documents: [], upload: null } as FrameInput["attach"],
  skills: [],
  commandIndex: 0,
  sizeColumns: 80,
  sizeRows: 24,
  contextOpen: null,
  queued: [],
  daemonQueue: undefined,
  loading: null,
  compacting: false,
  // The slot's two compaction figures + its clock (docs/feat/harness-notices.md
  // S3): at rest, nothing to show.
  compactingSince: null,
  compactedAt: null,
  now: 1_000,
  ...over,
});

describe("S10 app-layout: the frame's geometry, as the inline code computed it", () => {
  test("columns and rows keep their floors (20 columns, 8 rows)", () => {
    const narrow = frameLayout(base({ sizeColumns: 5, sizeRows: 2 }));
    expect(narrow.columns).toBe(20);
    expect(narrow.termRows).toBe(8);
    const wide = frameLayout(base({ sizeColumns: 120, sizeRows: 40 }));
    expect(wide.columns).toBe(120);
    expect(wide.termRows).toBe(40);
  });

  // The transcript's floor: `Math.max(3, termRows - (RESERVED_ROWS - 1 + activeRows))`.
  // RESERVED_ROWS is 4, so the subtrahend is 3 + activeRows. A 24-row terminal at
  // rest (input box 2 border rows, no palette, no dock) leaves 24 - (3 + 2) = 19.
  test("the viewport is the terminal minus the reserved rows and the bottom area", () => {
    const idle = frameLayout(base());
    // An empty draft still OWNS one content line (`inputRowCount("")` is 1: the
    // line the cursor sits on), plus the box's two borders.
    expect(idle.inputContentLines).toBe(1);
    expect(idle.inputBoxRows).toBe(3);
    expect(idle.activeRows).toBe(3);
    expect(idle.viewport).toBe(24 - (3 + 3));
  });

  test("the viewport never collapses below 3 rows, however tall the bottom area", () => {
    // A tiny terminal: the floor is what keeps the transcript from disappearing
    // (and the frame from overflowing the alternate screen).
    const tiny = frameLayout(base({ sizeRows: 8, sizeColumns: 80 }));
    expect(tiny.viewport).toBeGreaterThanOrEqual(3);
  });

  // A permission prompt REPLACES the whole bottom area: the dock reserves nothing
  // even when the dropdown is FOCUSED and would otherwise paint (U5 — a dock that
  // kept its rows would push the frame past the screen under the prompt).
  test("a pending permission prompt takes the bottom area and zeroes the dock", () => {
    const ROW = { id: "sa-1", agentType: "explore", description: "d", state: "running" };
    const listed = {
      ...IDLE_DOCK,
      focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
    } as DockState;
    // Sanity: the same dock DOES take rows when nothing is asking.
    const open = frameLayout(
      base({ dock: listed, subagents: [ROW] as never, subagentsRef: { current: [ROW] as never } }),
    );
    expect(open.dockHeight).toBeGreaterThan(0);
    expect(open.dockTop).not.toBe(null);
    const asked = frameLayout(
      base({
        dock: listed,
        subagents: [ROW] as never,
        subagentsRef: { current: [ROW] as never },
        permission: noPermission({
          pending: { kind: "tool" } as never,
          choices: [{ label: "Allow once", response: "allow" }] as never,
        }),
      }),
    );
    expect(asked.dockHeight).toBe(0);
    expect(asked.dockTop).toBe(null);
    // …and the prompt's own rows are what `activeRows` sums.
    expect(asked.activeRows).toBeGreaterThanOrEqual(1);
  });

  test("a quit confirm owns the screen: its row count, no dock row", () => {
    const quitting = frameLayout(base({ quitConfirm: { running: 0, others: 0 } as never }));
    expect(quitting.activeRows).toBe(3); // QUIT_CONFIRM_ROWS (the dialog's rule+rows)
    expect(quitting.dockTop).toBe(null);
  });

  test("the artifact open confirm owns the same slot (model-artifacts S6b)", () => {
    const ROW = { id: "sa-1", agentType: "explore", description: "d", state: "running" };
    const withList = {
      dock: {
        ...IDLE_DOCK,
        focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
      } as DockState,
      subagents: [ROW] as never,
      subagentsRef: { current: [ROW] as never },
    };
    // Non-vacuity: the same focused dock DOES paint while nothing asks.
    expect(frameLayout(base(withList)).dockTop).not.toBe(null);
    const asking = frameLayout(base({ ...withList, artifactConfirm: { text: "Open? (y/N)" } }));
    expect(asking.activeRows).toBe(3);
    expect(asking.dockTop).toBe(null);
    expect(asking.dockView).toBe(null);
  });

  // The palette only opens while idle, on "/"-prefixed text, and it closes on an
  // EXACT unambiguous match (`matchCommands`'s rule) — a decision, not a guess.
  test("the palette opens on a bare slash, windows the rows, and closes on an exact match", () => {
    const bare = frameLayout(base({ field: { value: "/", cursor: 1 } }));
    expect(bare.paletteOpen).toBe(true);
    expect(bare.paletteRows.length).toBeGreaterThan(0);
    expect(bare.paletteWin.start).toBe(0);
    // The palette's rows are part of the bottom area while it is open.
    expect(bare.activeRows).toBe(bare.inputBoxRows + bare.paletteRows.length);
    // An exact, unambiguous name means "fully typed": nothing to suggest.
    const exact = frameLayout(base({ field: { value: "/clear", cursor: 6 } }));
    expect(exact.paletteOpen).toBe(false);
    // …and a running turn never shows it.
    const running = frameLayout(
      base({ field: { value: "/", cursor: 1 }, state: idleState({ running: true }) }),
    );
    expect(running.paletteOpen).toBe(false);
  });

  test("the palette's selection is clamped into range and drives the window", () => {
    const stale = frameLayout(base({ field: { value: "/", cursor: 1 }, commandIndex: 9_999 }));
    expect(stale.commandSel).toBe(stale.paletteCommands.length - 1);
    const negative = frameLayout(base({ field: { value: "/", cursor: 1 }, commandIndex: -5 }));
    expect(negative.commandSel).toBe(0);
  });

  // The running rows: the thinking line, then the queued rows + their separator,
  // then one blank row between the hint and the thinking line.
  test("running rows count the thinking line, the queued lines and the blank spacer", () => {
    const one = frameLayout(base({ state: idleState({ running: true }) }));
    expect(one.shown.length).toBe(0);
    expect(one.runningRows).toBe(1); // just the thinking line
    const queued = frameLayout(
      base({
        state: idleState({ running: true }),
        queued: [{ id: "q1", text: "queued task" }] as never,
      }),
    );
    // 1 (thinking) + (1 queued + 1 separator) + 1 blank spacer = 4.
    expect(queued.runningRows).toBe(4);
    // The daemon's list joins mine (every writer's rows), so the count follows.
    const both = frameLayout(
      base({
        state: idleState({ running: true }),
        queued: [{ id: "q1", text: "mine" }] as never,
        daemonQueue: { entries: [{ id: "q2", text: "another device's" }] },
      }),
    );
    expect(both.shown.length).toBe(2);
    // Two shown rows: thinking + (2 queued + 1 separator) + 1 blank spacer = 5.
    expect(both.runningRows).toBe(5);
  });

  test("a compacting turn counts the queued rows but not the thinking line", () => {
    const compacting = frameLayout(
      base({ compacting: true, queued: [{ id: "q1", text: "queued" }] as never }),
    );
    // No thinking line (the turn is not running), but the queued row + its
    // separator, and no blank spacer (that one needs a RUNNING turn).
    expect(compacting.runningRows).toBe(2);
  });

  // An empty draft has NO attach row; a chip adds exactly one row INSIDE the box
  // (so the viewport shrinks once and the frame's height never changes, P8).
  test("the attach row adds one row inside the input box, and none when the draft is empty", () => {
    const empty = frameLayout(base());
    expect(empty.attachRow).toBe(null);
    expect(empty.inputBoxRows).toBe(3);
    const chipped = frameLayout(
      base({
        attach: { chips: [CHIP], documents: [], upload: null } as never,
      }),
    );
    expect(chipped.attachRow).not.toBe(null);
    expect(chipped.inputBoxRows).toBe(4);
  });

  test("a multi-line draft grows the input box by its content rows, capped", () => {
    const three = frameLayout(base({ field: { value: "a\nb\nc", cursor: 5 } }));
    expect(three.inputContentLines).toBe(3);
    expect(three.inputBoxRows).toBe(5); // 3 content + 2 borders
    // MAX_INPUT_ROWS caps the box; the rest is windowed around the cursor.
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const capped = frameLayout(base({ field: { value: long, cursor: long.length } }));
    expect(capped.inputContentLines).toBe(10);
  });

  test("the status bar's row is the sum of the parts the tree paints above it", () => {
    const at = frameLayout(base());
    // viewport + spacer + workflow rail + running rows + dock height + input box
    // + the bar's own.
    expect(at.statusRowY).toBe(
      at.viewport +
        1 +
        at.workflowHeight +
        at.catalogueHeight +
        at.runningRows +
        at.dockHeight +
        at.inputBoxRows +
        1,
    );
    // …and it is INVARIANT under the attach row, which is the whole point of
    // counting that row INSIDE the input box (P8): the viewport shrinks by one
    // exactly as the box grows by one, so the bar — and a click on the pill —
    // stays where it was while a chip appears or an upload starts.
    const chipped = frameLayout(
      base({ attach: { chips: [CHIP], documents: [], upload: null } as never }),
    );
    expect(chipped.inputBoxRows).toBe(at.inputBoxRows + 1);
    expect(chipped.viewport).toBe(at.viewport - 1);
    expect(chipped.statusRowY).toBe(at.statusRowY);
  });

  test("the panel's body row and the dock's top row follow the same parts", () => {
    const at = frameLayout(base());
    expect(at.panelBodyTop).toBe(at.viewport + 1 + at.runningRows + 2);
    // At rest the dock paints nothing, so it has no row.
    expect(at.dockTop).toBe(null);
  });

  // Freshness (H3): the dock's view reads the REF, not the rendered value — the
  // source does not change when the code moves, so two keys with no render
  // between them behave as before. Pinned by making the two disagree.
  test("the dock's dropdown reads the rows REF, not the rendered value", () => {
    const REF_ROW = {
      id: "sa-1",
      agentType: "explore",
      description: "from the ref",
      state: "running",
    };
    const laid = frameLayout(
      base({
        subagents: [
          { id: "sa-2", agentType: "explore", description: "from state", state: "running" },
        ] as never,
        subagentsRef: { current: [REF_ROW] as never },
        dock: {
          ...IDLE_DOCK,
          focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
        },
      }),
    );
    expect(laid.dockView).not.toBe(null);
    // The ref's row is what the view paints (the state copy is the older one).
    expect(JSON.stringify(laid.dockView)).toContain("from the ref");
    expect(JSON.stringify(laid.dockView)).not.toContain("from state");
  });

  // A PANEL owns the bottom slot instead of the input box, so it must (a) take
  // `activeRows`' place in the sum and (b) make `dockTop` null — a dock row
  // counted over a panel would put every click one row off (U12/U13).
  test("a panel replaces the input box and takes the dock's slot", () => {
    const at = frameLayout(base());
    const panel = frameLayout(
      base({
        panel: skillsPanel() as never,
        subagents: [{ id: "sa-1", state: "running" }] as never,
        dock: {
          ...IDLE_DOCK,
          focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
        },
      }),
    );
    expect(panel.listView).not.toBe(null);
    // The panel's own height replaces the input box's (+ palette rows).
    expect(panel.activeRows).toBe(panel.runningRows + panelHeightOf(panel) + panel.dockHeight);
    expect(panel.activeRows).not.toBe(at.activeRows);
    // A panel owns the slot: no dock row even with the dropdown focused.
    expect(panel.dockTop).toBe(null);
  });

  test("the palette also takes the dock's slot (it only opens while idle)", () => {
    const palette = frameLayout(base({ field: { value: "/", cursor: 1 } }));
    expect(palette.paletteOpen).toBe(true);
    expect(palette.dockTop).toBe(null);
  });

  test("an empty dock paints no dropdown and takes no rows", () => {
    const empty = frameLayout(
      base({
        dock: {
          ...IDLE_DOCK,
          focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
        },
      }),
    );
    expect(empty.dockView).toBe(null);
    expect(empty.dockHeight).toBe(0);
  });

  test("the context fill follows the daemon's count, and is unknown without one", () => {
    const fromDaemon = frameLayout(base({ contextOpen: { used: 64_000, exact: true } }));
    expect(fromDaemon.ctxShown).toEqual({ used: 64_000, approx: false });
    const unknown = frameLayout(base());
    expect(unknown.ctxShown.used).toBe(null);
    // No usage measured yet: the totals slot is null, not a zero.
    expect(unknown.tokensShown.totals).toBe(null);
  });

  // The pill: ONE control whose words are the pure view-model's, and whose focus
  // is the dock's (so a key and a click cannot disagree about it).
  test("the pill paints nothing when no background work exists", () => {
    expect(frameLayout(base()).pill.kind).toBe("none");
    const one = frameLayout(base({ subagents: [{ id: "sa-1", state: "running" }] as never }));
    expect(one.pill.kind).not.toBe("none");
  });

  test("the reply field's view appears only while the reply mode is open", () => {
    const menu = frameLayout(base());
    expect(menu.replyShown).toBeUndefined();
    expect(menu.replyMax).toBe(0);
    const replying = frameLayout(
      base({
        permission: noPermission({
          pending: { kind: "tool", reply: { maxChars: 500 } } as never,
          mode: { mode: "reply", editor: { value: "hi", cursor: 2, anchor: null } } as never,
        }),
      }),
    );
    expect(replying.replyShown).not.toBeUndefined();
    expect(replying.replyMax).toBe(500);
    // A PENDING request still in MENU mode has a draft limit but no reply view:
    // the field appears only in reply mode (U14).
    const menuMode = frameLayout(
      base({
        permission: noPermission({ pending: { kind: "tool", reply: { maxChars: 500 } } as never }),
      }),
    );
    expect(menuMode.replyMax).toBe(500);
    expect(menuMode.replyShown).toBeUndefined();
  });

  test("the job drawer's budget shrinks with the terminal, never below one row", () => {
    const job = { id: "bg-1", command: "tail", startedAt: 0, status: "running" };
    const open = {
      ...IDLE_DOCK,
      focus: { kind: "open", id: "bg-1", ended: null, frozen: null },
    } as DockState;
    // A job with a long output tail, so the budget is what bounds it.
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const roomy = frameLayout(
      base({ drawerJob: job as never, dock: open, jobOutput: { "bg-1": { output } } }),
    );
    const tight = frameLayout({
      ...base({ drawerJob: job as never, dock: open, jobOutput: { "bg-1": { output } } }),
      sizeRows: 8,
    });
    expect(roomy.drawer).not.toBe(null);
    expect(tight.drawer).not.toBe(null);
    // A short terminal gives the drawer fewer body rows (Review 4: the frame must
    // not grow past the screen), and the floor keeps it paintable (> 0).
    const rows = (d: typeof roomy.drawer) => (d === null ? 0 : d.tail.length);
    expect(rows(roomy.drawer)).toBeGreaterThan(0);
    expect(rows(tight.drawer)).toBeLessThan(rows(roomy.drawer));
    // On an 8-row terminal the budget floor is what it has: the drawer still
    // PAINTS (head at least), and its tail is squeezed to nothing rather than
    // pushed past the screen — the frame must never exceed the terminal.
    expect(tight.drawer).not.toBe(null);
    expect(rows(tight.drawer)).toBeLessThanOrEqual(8);
    expect(tight.viewport).toBeGreaterThanOrEqual(3);
  });
});
