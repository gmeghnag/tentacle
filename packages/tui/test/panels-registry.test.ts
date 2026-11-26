/**
 * docs/feat/app-decomposition.md S7 — "new panel = file + registry line".
 *
 * The plan's H4(4) makes that claim *conditional*: S7 must replace `panel.ts`'s
 * `kind ===` branches and the panel key paths with PER-PANEL descriptors, or the
 * claim is dropped from the doc. So this file pins it where it can be false:
 *
 * 1. **Delegation is a KIND LOOKUP, not a central switch.** The three facades
 *    (`panelView`/`applyPanel`/`panelClick`) and the two panel key layers ask the
 *    registry for the open panel's own descriptor. Proved with a SYNTHETIC fourth
 *    kind wired in by ONE list entry: a facade that had kept a `kind ===` branch
 *    would fall into another kind's arm for it instead of answering through it.
 * 2. **Every real kind is described**, by exactly one descriptor, each claiming
 *    its own `kind` and the layer it takes keys on.
 * 3. **The three `/sessions` state rules are the kind's own**, closed over the
 *    module the move created — where a frame test cannot see them (the slice's
 *    Execution records that they are redundant at the App seam), so they are
 *    pinned here, mutated in that table (M4–M7), and each refused rule proves
 *    another kind's panel comes back by IDENTITY.
 *
 * This file imports the NEW modules, so it is green on the pre-S7 tree too; its
 * non-vacuity comes from the S7 mutation table, not from a re-run of old code.
 */
import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { NOTHING } from "../src/keys/contract.ts";
import type { KeySnapshot } from "../src/keys/snapshot.ts";
import {
  type OpenPanel,
  applyPanel,
  mcpPanel,
  panelClick,
  panelView,
  sessionsPanel,
  skillsPanel,
} from "../src/panel.ts";
import {
  PANEL_KINDS,
  type PanelAt,
  type PanelKind,
  kindOf,
  panelStep,
} from "../src/panels/registry.ts";
import {
  isSessionsOpen,
  touchPanel,
  withSessionsRefresh,
  withSessionsState,
} from "../src/panels/sessions.ts";
import type { SessionsView } from "../src/sessions-panel.ts";
import type { PanelView, TreeAction } from "../src/tree-panel.ts";
import { noteView } from "../src/tree-panel.ts";

const NO_KEY: Key = {
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
};

const AT: PanelAt = { width: 80, maxBody: 10, current: "s1" };

function snap(over: Partial<KeySnapshot> = {}, char = "", key: Partial<Key> = {}): KeySnapshot {
  return {
    char,
    key: { ...NO_KEY, ...key },
    quitConfirm: () => null,
    dock: () => ({ focus: { kind: "input" }, drafts: {}, sent: {} }) as never,
    chord: () => ({ armedAt: null }),
    running: () => false,
    compacting: () => false,
    pasteBuffer: () => null,
    replyMaxChars: 0,
    dockIds: () => [],
    othersOnSession: () => 0,
    sessionId: () => "s1",
    switching: () => false,
    panelGen: () => 0,
    abortable: () => false,
    uploadInFlight: () => false,
    exitPending: () => false,
    subagents: () => [],
    jobRows: () => [],
    panel: null,
    paletteOpen: false,
    paletteNames: [],
    commandSel: 0,
    fieldValue: "",
    permission: {
      pending: null,
      choices: [],
      selected: 0,
      mode: () => ({ mode: "menu" }),
      // `0` = the arming window has long passed (docs/fix/quit-enter-ask.md).
      shownAt: () => 0,
    },
    sessions: undefined,
    detachOnQuit: false,
    voice: () => "idle",
    voiceKey: () => "ctrl+r",
    ...over,
  } as KeySnapshot;
}

// --- a SYNTHETIC fourth panel: a kind the real union does not have -----------
interface FakePanel {
  readonly kind: "fake";
  readonly n: number;
}

const fakeView = (panel: FakePanel, at: PanelAt): PanelView =>
  noteView(`FAKE ${panel.n}`, `at ${at.width}/${at.maxBody}`, at.width);

const fakeKind: PanelKind<FakePanel> = {
  kind: "fake",
  layer: "tree",
  // Its OWN projection: no real kind's `view` could produce this text.
  view: fakeView,
  apply: (panel, action: TreeAction) => (action === "down" ? { ...panel, n: panel.n + 1 } : panel),
  click: (panel, _view: PanelView, bodyIndex: number) =>
    bodyIndex === 0 ? { ...panel, n: panel.n + 9 } : panel,
  key: (_panel, s: KeySnapshot) =>
    s.char === "x"
      ? { effects: [{ kind: "closePanel" }], verdict: "consumed", carry: "" }
      : NOTHING,
};

/** The synthetic registry: the real three plus the fourth, added by ONE entry. */
const WITH_FAKE: readonly PanelKind<FakePanel>[] = [fakeKind];

const fake = (n = 1): FakePanel => ({ kind: "fake", n });

describe("S7: a panel kind is described by its OWN descriptor, found by lookup", () => {
  test("every real kind has exactly one descriptor, claiming its own `kind`", () => {
    const kinds = PANEL_KINDS.map((k) => k.kind);
    // `/artifacts` (docs/feat/model-artifacts.md S6a) and `/schedule`
    // (docs/feat/cron-tool.md S5) joined the original three, then `/tools`
    // (docs/feat/tool-toggles.md D7), then `/browser` (browser-inspect B6a).
    expect(kinds.slice().sort()).toEqual([
      "artifacts",
      "browser",
      "mcp",
      "schedule",
      "sessions",
      "skills",
      "tools",
      "workflow",
    ]);
    for (const desc of PANEL_KINDS) {
      // A descriptor whose `kind` field disagreed with its body would hand a
      // panel to another kind's projection.
      expect(desc.kind).toBe(kindOf({ kind: desc.kind } as OpenPanel).kind);
      expect(PANEL_KINDS.filter((k) => k.kind === desc.kind)).toHaveLength(1);
    }
  });

  test("a FOURTH kind is wired in by one registry entry and nothing else", () => {
    const desc = kindOf(fake(3), WITH_FAKE);
    expect(desc.kind).toBe("fake");
    expect(desc.view(fake(3), AT).title).toBe("FAKE 3");
    expect(desc.view(fake(3), AT).rows.map((r) => r.text)).toEqual(["  at 80/10"]);
    expect(desc.apply(fake(1), "down", 80)).toEqual({ kind: "fake", n: 2 });
    expect(desc.click(fake(1), fakeView(fake(1), AT), 0, 80)).toEqual({ kind: "fake", n: 10 });
    // And a panel no registry describes is an honest throw, never a quiet
    // fall-through into another kind's arm (the pre-S7 `kind ===` shape).
    expect(() => kindOf(fake())).toThrow(/No panel descriptor/);
  });

  test("the panel KEY layers are the descriptors' decision too", () => {
    // The synthetic kind claims "x" on the `tree` layer.
    const x = panelStep(
      snap({ panel: fake() as unknown as OpenPanel }, "x"),
      "tree",
      WITH_FAKE as unknown as readonly PanelKind<OpenPanel>[],
    );
    expect(x).toEqual({ effects: [{ kind: "closePanel" }], verdict: "consumed", carry: "" });
    // ...and is offered nothing on the `sessions` layer.
    expect(
      panelStep(
        snap({ panel: fake() as unknown as OpenPanel }, "x"),
        "sessions",
        WITH_FAKE as unknown as readonly PanelKind<OpenPanel>[],
      ),
    ).toEqual(NOTHING);
    // Every real kind names the layer it takes keys on: the two CURSOR lists
    // (`/sessions`, `/schedule`) share the flat-list layer, the three tree kinds
    // (`/mcp`, `/skills`, `/artifacts`) the tree layer (the 14-name order is
    // untouched: `keys/layers.ts` still lists sessions then tree — `/schedule`
    // rides the same one).
    for (const desc of PANEL_KINDS) {
      // `/workflow` (docs/feat/workflows-ui.md D3) is a cursor list too.
      const flat = desc.kind === "sessions" || desc.kind === "schedule" || desc.kind === "workflow";
      expect(desc.layer).toBe(flat ? "sessions" : "tree");
    }
  });

  test("no panel open ⇒ both panel layers pass (the mouse layer's job below)", () => {
    expect(panelStep(snap(), "sessions")).toEqual(NOTHING);
    expect(panelStep(snap(), "tree")).toEqual(NOTHING);
  });
});

describe("S7: the `/sessions` kind's own state rules (the boundary the move created)", () => {
  // These three were `kind === "sessions"` branches inline in App.tsx. At the App
  // seam each is REDUNDANT (the generation gate and a re-render already cover the
  // case), so a frame test cannot see them — the slice's mutation table records
  // exactly that. Their contract is therefore pinned HERE, on the module that now
  // owns it, which is what makes them rules rather than ceremony.
  const view = (ids: readonly string[]): SessionsView => ({
    sessions: ids.map((id) => ({
      id,
      title: `t ${id}`,
      updatedAt: 0,
      running: false,
      attached: 0,
      archived: false,
    })),
    more: false,
  });
  const sessions = (): OpenPanel => ({ ...sessionsPanel(0), data: view(["a", "b", "c"]) });
  const mcp = (): OpenPanel => mcpPanel();

  test("withSessionsState writes the state of a `/sessions` panel and nothing else", () => {
    const state = { cursor: 2, armed: { id: "c", at: 1 } as never };
    const next = withSessionsState(sessions(), state);
    expect(next).toMatchObject({ kind: "sessions", state });
    expect(next).not.toBe(sessions());
    // Another kind (and no panel) is returned UNCHANGED, by identity: the write
    // must never reshape a panel that is not a `/sessions` one.
    const m = mcp();
    expect(withSessionsState(m, { cursor: 1, armed: null })).toBe(m);
    expect(withSessionsState(null, { cursor: 1, armed: null })).toBeNull();
  });

  test("touchPanel re-reads a `/sessions` panel with the SAME content (a repaint, not a reset)", () => {
    const p = sessions();
    const touched = touchPanel(p);
    expect(touched).not.toBe(p); // a new object ⇒ React re-renders the live "current" row
    expect(touched).toEqual(p); // ...and nothing in it changed
    const m = mcp();
    expect(touchPanel(m)).toBe(m);
    expect(touchPanel(null)).toBeNull();
  });

  test("withSessionsRefresh replaces the list, re-stamps it, and re-derives the state", () => {
    const p = {
      ...sessionsPanel(1),
      data: view(["a", "b", "c"]),
      state: { cursor: 2, armed: null },
    } as OpenPanel;
    const next = withSessionsRefresh(p, view(["a"]));
    expect(next).toMatchObject({ kind: "sessions", data: { sessions: [{ id: "a" }] } });
    // The cursor is kept IN RANGE and a pending delete is disarmed: the delete
    // just went through, so the confirm cannot survive its own row.
    expect((next as { state: { cursor: number; armed: unknown } }).state).toEqual({
      cursor: 0,
      armed: null,
    });
    expect((next as { now: number }).now).toBeGreaterThanOrEqual(1);
    const m = mcp();
    expect(withSessionsRefresh(m, view(["a"]))).toBe(m);
    expect(withSessionsRefresh(null, view(["a"]))).toBeNull();
  });

  test("isSessionsOpen answers only for a `/sessions` panel", () => {
    expect(isSessionsOpen(sessions())).toBe(true);
    expect(isSessionsOpen(mcp())).toBe(false);
    expect(isSessionsOpen(null)).toBe(false);
  });
});

describe("S7: the facade answers for every real panel through its descriptor", () => {
  test("panelView projects each kind through its own module", () => {
    expect(panelView(sessionsPanel(0), 80, 10).title).toContain("Sessions");
    // Each loading panel says so in its own words (`noteView`'s title + one row).
    expect(panelView(mcpPanel(), 80, 10).title).toBe("MCP servers · probing…");
    expect(panelView(skillsPanel(), 80, 10).title).toBe("Skills · loading…");
    expect(panelView(skillsPanel(), 80, 10).rows.map((r) => r.text)).toEqual([
      "  Asking the daemon…",
    ]);
    // The injected server list reaches the MCP projection (its own `groups`).
    expect(
      panelView(
        mcpPanel([{ name: "a", state: "connected", tools: [], moreTools: 0, latencyMs: 1 }]),
        80,
        10,
      ).title,
    ).toContain("1 of 1 reachable");
  });

  test("applyPanel applies each kind's own transition", () => {
    const mcp = mcpPanel([
      { name: "a", state: "connected", tools: [], moreTools: 0, latencyMs: 1 },
      { name: "b", state: "connected", tools: [], moreTools: 0, latencyMs: 1 },
    ]);
    expect(applyPanel(mcp, "down", 80).tree.cursor).toBe(1);
    // The sessions panel only MOVES: any other action leaves it identical.
    const sessions = sessionsPanel(0);
    expect(applyPanel(sessions, "up", 80)).not.toBe(sessions);
    expect(applyPanel(sessions, "toggle", 80)).toBe(sessions);
  });

  test("panelClick applies each kind's own body-row decision", () => {
    const mcp = mcpPanel([
      { name: "a", state: "connected", tools: [], moreTools: 0, latencyMs: 1 },
      { name: "b", state: "connected", tools: [], moreTools: 0, latencyMs: 1 },
    ]);
    expect(panelClick(mcp, panelView(mcp, 80, 10), 1, 80).tree.cursor).toBe(1);
    // A sessions panel has no expandable body: a click on its row is a no-op here
    // (the choose/switch path is its `key`, not its `click`).
    const sessions = sessionsPanel(0);
    expect(panelClick(sessions, panelView(sessions, 80, 10), 5, 80)).toBe(sessions);
  });
});
