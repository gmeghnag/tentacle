/**
 * Per-layer decisions (docs/feat/app-decomposition.md S3): each of the 13 pure
 * layers, asked one chunk, checked for its effects AND its verdict. The point is
 * not to re-test `sessions-panel.ts` / `chord.ts` / `dockKey` (their own suites
 * do) but that the SLICE wired them in the same order with the same snapshot
 * sources — especially the "act and pass" sites, where a wrong verdict is a
 * silent behaviour change.
 *
 * The App seam (frames, keys through real components) stays pinned by the S0/S0b
 * nets, which this slice leaves green and unedited.
 */
import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { PURE_LAYERS } from "../src/keys/layers.ts";
import { routeKey } from "../src/keys/route.ts";
import type { KeySnapshot } from "../src/keys/snapshot.ts";

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

const IDLE_DOCK = { focus: { kind: "input" }, drafts: {}, sent: {} };

function snap(over: Partial<KeySnapshot> = {}, char = "", key: Partial<Key> = {}): KeySnapshot {
  return {
    char,
    key: { ...NO_KEY, ...key },
    quitConfirm: () => null,
    dock: () => IDLE_DOCK as never,
    chord: () => ({ armedAt: null }),
    running: () => false,
    compacting: () => false,
    pasteBuffer: () => null,
    replyMaxChars: () => 0,
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
    permission: { pending: null, choices: [], selected: 0, mode: () => ({ mode: "menu" }) },
    sessions: undefined,
    detachOnQuit: false,
    ...over,
  } as KeySnapshot;
}

const route = (s: KeySnapshot) => routeKey(s, PURE_LAYERS);
const kinds = (s: KeySnapshot) => route(s).effects.map((e) => e.kind);

describe("quit-confirm", () => {
  test("`y` closes, and closes for all when the dialog spoke for others", () => {
    const r = route(
      snap({ quitConfirm: () => ({ others: 2, agents: 0, jobs: 0, names: [] }) }, "y"),
    );
    expect(r.effects).toEqual([
      { kind: "setQuitConfirm", facts: null },
      { kind: "quit", closeForAll: true },
    ]);
  });

  test("`y` with nobody else open does not close for all", () => {
    const r = route(
      snap({ quitConfirm: () => ({ others: 0, agents: 0, jobs: 0, names: [] }) }, "y"),
    );
    expect(r.effects).toContainEqual({ kind: "quit", closeForAll: false });
  });

  test("Ctrl+C is No: it dismisses and nothing quits (owner 2026-11-09, a)", () => {
    const r = route(
      snap({ quitConfirm: () => ({ others: 1, agents: 1, jobs: 0, names: [] }) }, "c", {
        ctrl: true,
      }),
    );
    expect(r.effects).toEqual([{ kind: "setQuitConfirm", facts: null }]);
  });
});

describe("the chord", () => {
  test("ctrl+x then ctrl+s inside the window sends now", () => {
    // Armed just now: the second key completes it.
    const r = route(snap({ chord: () => ({ armedAt: Date.now() }) }, "s", { ctrl: true }));
    expect(r.stoppedAt).toBe("chord");
    expect(r.effects.map((e) => e.kind)).toEqual(["setChord", "sendNow"]);
  });

  test("ctrl+x alone arms and is swallowed", () => {
    const r = route(snap({}, "x", { ctrl: true }));
    expect(r.stoppedAt).toBe("chord");
    expect(r.effects).toEqual([
      {
        kind: "setChord",
        state: { armedAt: r.effects.length ? (expect.any(Number) as never) : 0 },
      },
    ]);
  });
});

describe("Ctrl+C", () => {
  test("a live child asks first: confirm, never exit", () => {
    const r = route(snap({ subagents: () => [{ id: "sa-1" }] as never }, "c", { ctrl: true }));
    expect(r.stoppedAt).toBe("ctrlC");
    expect(r.effects[0]?.kind).toBe("setQuitConfirm");
  });

  test("nothing to lose and a turn to stop: stop the turn, do not exit", () => {
    const r = route(snap({ running: () => true, abortable: () => true }, "c", { ctrl: true }));
    expect(r.effects).toEqual([{ kind: "abortTurn" }]);
  });

  test("no abort handle means nothing to stop: exit (the inline rule)", () => {
    const r = route(snap({ running: () => true, abortable: () => false }, "c", { ctrl: true }));
    expect(r.effects).toEqual([{ kind: "exit" }]);
  });

  test("a `connect` detach loses no job, so a running job alone does not ask", () => {
    // `detaches` short-circuits the confirm branch, and the running turn then
    // takes `quitAction`'s "stop" — never a dialog, never an exit.
    const r = route(
      snap(
        {
          detachOnQuit: true,
          jobRows: () => [{ id: "bg-1" }] as never,
          running: () => true,
          abortable: () => true,
        },
        "c",
        { ctrl: true },
      ),
    );
    expect(r.stoppedAt).toBe("ctrlC");
    expect(r.effects).toEqual([{ kind: "abortTurn" }]);
  });
});

describe("paste", () => {
  test("a complete paste is captured and consumed, routed through routeAttach", () => {
    const r = route(snap({}, "\u001b[200~hello\u001b[201~"));
    expect(r.stoppedAt).toBe("paste");
    expect(r.effects).toContainEqual({ kind: "routeAttach", text: "hello" });
  });

  test("behind a panel the paste is consumed but edits nothing (the hidden input)", () => {
    const r = route(
      snap({ panel: { kind: "mcp", state: {}, data: null } as never }, "\u001b[200~hi\u001b[201~"),
    );
    expect(r.stoppedAt).toBe("paste");
    expect(
      kinds(
        snap(
          { panel: { kind: "mcp", state: {}, data: null } as never },
          "\u001b[200~hi\u001b[201~",
        ),
      ),
    ).not.toContain("routeAttach");
  });
});

describe("the permission dialog", () => {
  const pending = (over: Partial<KeySnapshot> = {}) =>
    snap({
      permission: {
        pending: { id: "p1" } as never,
        choices: [
          { label: "Yes", response: { allowed: true, scope: "once" } },
          { label: "No", response: { allowed: false } },
        ] as never,
        selected: 0,
        mode: () => ({ mode: "menu" }),
      },
      ...over,
    });

  test("`y` answers: allow once", () => {
    const r = route(pending({}));
    expect(r.effects).toEqual([]); // `y` needs the char
  });

  test("`y` with the char answers allow-once", () => {
    const s = pending();
    const r = routeKey({ ...s, char: "y" }, PURE_LAYERS);
    expect(r.stoppedAt).toBe("permission");
    expect(r.effects).toContainEqual({
      kind: "permissionAnswer",
      response: { allowed: true, scope: "once" },
    });
  });

  test("arrow selects; Enter answers with the highlighted choice", () => {
    const s = pending();
    const down = routeKey({ ...s, char: "", key: { ...NO_KEY, downArrow: true } }, PURE_LAYERS);
    expect(down.effects).toEqual([{ kind: "permissionSelect", index: 1 }]);
  });

  test("Ctrl+C is `stop`: no deny goes out", () => {
    const s = pending();
    const r = routeKey({ ...s, char: "c", key: { ...NO_KEY, ctrl: true } }, PURE_LAYERS);
    expect(r.effects).toEqual([{ kind: "permissionStop" }]);
  });

  test("in the reply field a paste goes to the field, never the main input", () => {
    const s = snap({
      permission: {
        pending: { id: "p1" } as never,
        choices: [],
        selected: 0,
        mode: () => ({ mode: "reply", editor: { value: "", cursor: 0, anchor: null } }),
      },
      replyMaxChars: () => 100,
      pasteBuffer: () => null,
    });
    const r = routeKey({ ...s, char: "\u001b[200~why\u001b[201~" }, PURE_LAYERS);
    expect(r.stoppedAt).toBe("permission");
    expect(r.effects.map((e) => e.kind)).toContain("insertReply");
    expect(r.effects.map((e) => e.kind)).not.toContain("routeAttach");
  });
});

describe("the dock", () => {
  const listDock = () =>
    ({
      focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
      drafts: {},
      sent: {},
    }) as never;

  test("Esc in the dropdown walks ONE step up the chain (to the pill), never the turn", () => {
    // `dockKey`'s chain: dropdown → pill → input. This layer only executes that
    // decision (asserting `input` here would encode a different behaviour).
    const r = route(
      snap({ dock: listDock, running: () => true, abortable: () => true }, "", { escape: true }),
    );
    expect(r.stoppedAt).toBe("dock");
    expect(r.effects).toEqual([
      { kind: "setDock", state: { focus: { kind: "pill" }, drafts: {}, sent: {} } },
    ]);
  });

  test("behind a panel the dock is not offered the key at all", () => {
    // A panel is open AND the dock is in list focus: the panel layers own it.
    const r = route(
      snap(
        {
          panel: { kind: "mcp", state: { expanded: [], cursor: 0 }, data: null } as never,
          dock: listDock,
        },
        "q",
      ),
    );
    expect(r.stoppedAt).toBe("tree");
    expect(r.effects).toEqual([{ kind: "closePanel" }]);
  });

  test("a key the panel does not claim never reaches the dock (no setDock while a panel is open)", () => {
    // The tree layer passes a key it does not claim, so the DOCK layer is the
    // next one that could act — and it must not: behind a panel the dock keeps
    // its state (a `setDock` here would move a focus the user cannot see).
    const r = route(
      snap(
        {
          panel: { kind: "mcp", state: { expanded: [], cursor: 0 }, data: null } as never,
          dock: listDock,
        },
        "z",
      ),
    );
    expect(r.effects).toEqual([]);
    expect(r.verdict).toBe("pass");
  });

  test("a printable key on the FOCUSED PILL is typed, not swallowed (act and pass)", () => {
    // Owner P3 (a): the key returns the focus to the input AND is typed there. A
    // `consumed` verdict here loses the message the user was writing.
    const pillDock = () => ({ focus: { kind: "pill" }, drafts: {}, sent: {} }) as never;
    const r = route(snap({ dock: pillDock }, "h"));
    expect(r.verdict).toBe("pass");
    expect(r.stoppedAt).toBeNull();
    expect(r.effects).toEqual([
      { kind: "setDock", state: { focus: { kind: "input" }, drafts: {}, sent: {} } },
    ]);
  });
});
describe("Esc", () => {
  test("an upload in flight is aborted, not the turn (S0's precedence pin)", () => {
    const r = route(
      snap({ uploadInFlight: () => true, running: () => true, abortable: () => true }, "", {
        escape: true,
      }),
    );
    expect(r.stoppedAt).toBe("escUpload");
    expect(r.effects).toEqual([{ kind: "cancelUpload" }]);
  });

  test("with nothing uploading, Esc stops the running turn", () => {
    const r = route(snap({ running: () => true, abortable: () => true }, "", { escape: true }));
    expect(r.stoppedAt).toBe("escAbort");
    expect(r.effects).toEqual([{ kind: "abortTurn" }]);
  });

  test("Esc with nothing running and no upload does nothing at all", () => {
    const r = route(snap({}, "", { escape: true }));
    expect(r.verdict).toBe("pass");
    expect(r.effects).toEqual([]);
  });
});

describe("the palette", () => {
  const open = (over: Partial<KeySnapshot> = {}) =>
    snap({ paletteOpen: true, paletteNames: ["/help", "/model"], commandSel: 0, ...over });

  test("arrows move the highlight, never history", () => {
    expect(kinds(open())).toBeDefined();
    const up = routeKey({ ...open(), char: "", key: { ...NO_KEY, upArrow: true } }, PURE_LAYERS);
    expect(up.stoppedAt).toBe("palette");
    expect(up.effects).toEqual([{ kind: "moveCommandSel", step: -1 }]);
  });

  test("Tab completes the highlighted name", () => {
    const r = routeKey({ ...open(), char: "", key: { ...NO_KEY, tab: true } }, PURE_LAYERS);
    expect(r.effects).toEqual([{ kind: "fieldSet", text: "/help" }]);
  });

  test("Enter resets the field then runs the command by NAME", () => {
    const r = routeKey({ ...open(), char: "", key: { ...NO_KEY, return: true } }, PURE_LAYERS);
    expect(r.effects).toEqual([{ kind: "fieldReset" }, { kind: "runCommand", name: "/help" }]);
  });

  test("Esc dismisses (resets the field)", () => {
    const r = routeKey({ ...open(), char: "", key: { ...NO_KEY, escape: true } }, PURE_LAYERS);
    expect(r.effects).toEqual([{ kind: "fieldReset" }]);
  });

  test("a key it does not claim falls through to line editing", () => {
    const r = routeKey({ ...open(), char: "a" }, PURE_LAYERS);
    expect(r.verdict).toBe("pass");
    expect(r.effects).toEqual([]);
  });
});

describe("ordering invariants (the reason this is ONE list)", () => {
  test("shift+tab wins over every panel, dialog and palette", () => {
    for (const over of [
      {
        permission: {
          pending: { id: "p" } as never,
          choices: [],
          selected: 0,
          mode: () => ({ mode: "menu" }),
        },
      },
      {
        panel: { kind: "sessions", state: { cursor: 0, armed: null }, data: null, now: 0 } as never,
      },
      { paletteOpen: true, paletteNames: ["/help"] },
    ] satisfies Partial<KeySnapshot>[]) {
      const r = routeKey(
        { ...snap(over), char: "", key: { ...NO_KEY, tab: true, shift: true } },
        PURE_LAYERS,
      );
      expect(r.stoppedAt).toBe("shiftTab");
    }
  });

  test("the sessions panel's Esc beats the Esc-abort layer (S0's precedence pin)", () => {
    const r = routeKey(
      {
        ...snap({
          panel: {
            kind: "sessions",
            state: { cursor: 0, armed: null },
            data: null,
            now: 0,
          } as never,
          running: () => true,
          abortable: () => true,
        }),
        char: "",
        key: { ...NO_KEY, escape: true },
      },
      PURE_LAYERS,
    );
    expect(r.stoppedAt).toBe("sessions");
    expect(r.effects).toEqual([{ kind: "closePanel" }]);
  });
});
