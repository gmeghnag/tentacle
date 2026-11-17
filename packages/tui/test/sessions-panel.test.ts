import { describe, expect, test } from "bun:test";
import { applyPanel, panelClick, panelView, sessionsPanel } from "../src/panel.ts";
import {
  SESSIONS_START,
  SWITCHING_NOTICE,
  SWITCHING_PROMPT_NOTICE,
  SWITCH_BUSY_NOTICE,
  type SessionsEntry,
  refreshedSessions,
  sessionRows,
  sessionsAt,
  sessionsChoose,
  sessionsDelete,
  sessionsKey,
  sessionsRefreshApplies,
  sessionsRowText,
  sessionsView,
  switchingRefusal,
} from "../src/sessions-panel.ts";

// The `/sessions` panel's logic (docs/feat/connect-sessions.md). Each rule
// names the mutation that turns it red (AGENTS §9).

const NOW = 10 * 60_000;
const entry = (id: string, o: Partial<SessionsEntry> = {}): SessionsEntry => ({
  id,
  title: `title ${id}`,
  updatedAt: NOW - 5 * 60_000,
  running: false,
  attached: 0,
  archived: false,
  ...o,
});

describe("sessionsRowText", () => {
  test("title · age · id8 · markers; the current row counts the OTHER devices", () => {
    // Mutation: count `attached` on the current row too → "on 2 devices".
    expect(
      sessionsRowText(entry("0123456789ab", { running: true, attached: 2 }), "0123456789ab", NOW),
    ).toBe("title 0123456789ab  5m ago · 01234567 · current · running · on 1 device");
    expect(sessionsRowText(entry("x", { attached: 2 }), "other", NOW)).toBe(
      "title x  5m ago · x · on 2 devices",
    );
    expect(sessionsRowText(entry("y", { archived: true }), null, NOW)).toBe(
      "title y  5m ago · y · archived",
    );
  });

  test("daemon strings are display-safe: a bidi override / newline in a title or id never reaches the row", () => {
    expect(sessionsRowText(entry("ab‮cd\nef", { title: "evil‮\ntitle" }), null, NOW)).toBe(
      "evil title  5m ago · abcd ef",
    );
  });
});

describe("sessionsView", () => {
  test("loading, empty, rows with the cursor, a footer when the daemon has more", () => {
    expect(sessionsView(null, SESSIONS_START, null, NOW, 80, 10).rows[0]?.text).toContain(
      "Asking the daemon",
    );
    expect(
      sessionsView({ sessions: [], more: false }, SESSIONS_START, null, NOW, 80, 10).rows[0]?.text,
    ).toContain("No sessions");
    const view = sessionsView(
      { sessions: [entry("a"), entry("b")], more: true },
      { cursor: 1, armed: null },
      "a",
      NOW,
      80,
      10,
    );
    expect(view.rows.map((r) => [r.text.slice(0, 9), r.selected])).toEqual([
      ["  title a", false],
      ["❯ title b", true],
      ["  … more ", false],
    ]);
    expect(view.title).toBe("Sessions (2+)");
  });

  test("an armed delete shows its confirmation in the hint", () => {
    const view = sessionsView(
      { sessions: [entry("a"), entry("b")], more: false },
      { cursor: 1, armed: "b" },
      "a",
      NOW,
      80,
      10,
    );
    expect(view.hint).toBe("press x again to delete title b · any other key cancels");
  });

  test("owner R3: an armed delete of a session RUNNING (daemon's list state) says its turn will stop", () => {
    // Mutation: ignore `running` → the plain confirmation.
    const view = sessionsView(
      { sessions: [entry("a"), entry("b", { running: true, attached: 1 })], more: false },
      { cursor: 1, armed: "b" },
      "a",
      NOW,
      80,
      10,
    );
    expect(view.hint).toBe(
      "press x again to delete title b — its running turn on another device will stop · any other key cancels",
    );
  });

  test("owner R2-5: a running session with no device attached says so, not 'another device'", () => {
    // Mutation: ignore `attached` → the 'another device' wording.
    const view = sessionsView(
      { sessions: [entry("a"), entry("b", { running: true, attached: 0 })], more: false },
      { cursor: 1, armed: "b" },
      "a",
      NOW,
      80,
      10,
    );
    expect(view.hint).toBe(
      "press x again to delete title b — its running turn (no device attached) will stop · any other key cancels",
    );
  });

  test("owner R3: a non-running session keeps the plain confirmation, even with devices attached or a title that mentions running", () => {
    const view = sessionsView(
      {
        sessions: [entry("a"), entry("b", { attached: 2, title: "running turn" })],
        more: false,
      },
      { cursor: 1, armed: "b" },
      "a",
      NOW,
      80,
      10,
    );
    expect(view.hint).toBe("press x again to delete running turn · any other key cancels");
  });
});

describe("pinned sessions first (docs/feat/mobile-session-actions.md S3)", () => {
  test("the first page's `pinned` array leads the list, deduped by id against the page", () => {
    // Mutation: render `data.sessions` alone → c arrives last (or not at all).
    // Mutation: no dedupe → `a` twice.
    const view = sessionsView(
      {
        sessions: [entry("a", { pinned: true }), entry("b")],
        pinned: [entry("a"), entry("c")],
        more: false,
      },
      SESSIONS_START,
      null,
      NOW,
      80,
      10,
    );
    expect(view.rows.map((r) => r.text.trimEnd())).toEqual([
      "❯ · title a  5m ago · a",
      "  · title c  5m ago · c",
      "  title b  5m ago · b",
    ]);
    expect(view.title).toBe("Sessions (3)");
  });

  test("a pin older than the page still shows, first and marked with a thin ·, not an emoji", () => {
    // Mutation: drop the `entry.pinned` lead → the row is unmarked.
    const view = sessionsView(
      { sessions: [entry("new"), entry("mid")], pinned: [entry("old")], more: true },
      SESSIONS_START,
      null,
      NOW,
      80,
      10,
    );
    expect(view.rows[0]?.text.trimEnd()).toBe("❯ · title old  5m ago · old");
    // A pinned archived row keeps its own markers (owner Q3).
    expect(sessionsRowText(entry("z", { pinned: true, archived: true }), null, NOW)).toBe(
      "· title z  5m ago · z · archived",
    );
    expect(view.rows.some((r) => r.text.includes("📌"))).toBe(false);
  });

  test("with no pins the order and the text are exactly today's", () => {
    // Mutation: reorder unconditionally → b before a.
    const view = sessionsView(
      { sessions: [entry("a"), entry("b")], more: false },
      SESSIONS_START,
      null,
      NOW,
      80,
      10,
    );
    expect(view.rows.map((r) => r.text.trimEnd())).toEqual([
      "❯ title a  5m ago · a",
      "  title b  5m ago · b",
    ]);
    expect(
      sessionRows({ sessions: [entry("a"), entry("b")], more: false }).map((e) => e.id),
    ).toEqual(["a", "b"]);
  });

  test("the cursor, the armed delete and a refresh all follow the shown order", () => {
    // Mutation: `sessionsAt`/`refreshedSessions` keep reading `data.sessions` → cursor picks `a`, not the hoisted `c`.
    const data = { sessions: [entry("a"), entry("b")], pinned: [entry("c")], more: false };
    expect(sessionRows(data).map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(sessionsAt(data, { cursor: 0, armed: null })?.id).toBe("c");
    expect(sessionsAt(data, { cursor: 2, armed: null })?.id).toBe("b");
    expect(refreshedSessions({ cursor: 9, armed: null }, data)).toEqual({ cursor: 2, armed: null });
    // A delete armed on a hoisted pin names THAT pin's id, never the page row
    // under the cursor — the wrong-session hazard of reordering (M4).
    const at = sessionsAt(data, { cursor: 0, armed: null });
    expect(at === undefined ? null : sessionsDelete(SESSIONS_START, at, null)).toMatchObject({
      kind: "arm",
      state: { armed: "c" },
    });
  });

  test("the panel's own MOVE and CLICK reach a row the page alone does not hold", () => {
    // Review fix round 1, finding 1: `apply` and `click` are the two call sites
    // outside `sessions-panel.ts`, and they must count the rows SHOWN. Page
    // [a,b] plus one hoisted pin c ⇒ 3 rows; a page-length count would wrap ↑↓
    // at 2 and ignore a click on row 3, making the last hoisted row unreachable.
    // Mutation: `sessionRows(panel.data).length` → `panel.data?.sessions.length ?? 0`
    // in `apply` (M7) or in `click`'s `count` (M8) → this test reds.
    const data = { sessions: [entry("a"), entry("b")], pinned: [entry("c")], more: false };
    // The rows shown are c, a, b (3); a page-length count would see only 2 and
    // wrap a step early. From row 1: "down" reaches the last row (2), not 0...
    const atOne = { ...sessionsPanel(NOW, data), state: { cursor: 1, armed: null } };
    expect(applyPanel(atOne, "down", 80)).toMatchObject({ state: { cursor: 2 } });
    // ...and "up" from the first row reaches 2, not 1.
    const atZero = { ...sessionsPanel(NOW, data), state: { cursor: 0, armed: null } };
    expect(applyPanel(atZero, "up", 80)).toMatchObject({ state: { cursor: 2 } });
    // A click on body row 2 (the last shown) moves the cursor there; with a
    // page-length bound `2 < 2` is false and the click is ignored.
    const view = panelView(sessionsPanel(NOW, data), 80, 10);
    expect(view.rows).toHaveLength(3);
    const clicked = panelClick(sessionsPanel(NOW, data), view, 2, 80);
    expect(clicked.kind === "sessions" ? clicked.state.cursor : null).toBe(2);
    expect(clicked.kind === "sessions" ? sessionsAt(clicked.data, clicked.state)?.id : null).toBe(
      "b",
    );
  });
});

describe("sessionsKey", () => {
  test("↑↓ move · enter choose · x delete · esc/q close", () => {
    expect(sessionsKey("", { upArrow: true })).toBe("up");
    expect(sessionsKey("", { downArrow: true })).toBe("down");
    expect(sessionsKey("", { return: true })).toBe("choose");
    expect(sessionsKey("x", {})).toBe("delete");
    expect(sessionsKey("", { escape: true })).toBe("close");
    expect(sessionsKey("q", {})).toBe("close");
    expect(sessionsKey("z", {})).toBe("none");
  });
});

describe("sessionsChoose", () => {
  test("the current row → stay; busy (any device's turn) → refused; else switch, reopen iff archived", () => {
    // Mutation: ignore `busy` → a switch mid-turn.
    expect(sessionsChoose(entry("a"), "a", false)).toEqual({ kind: "stay" });
    expect(sessionsChoose(entry("b"), "a", true)).toEqual({
      kind: "refused",
      text: SWITCH_BUSY_NOTICE,
    });
    expect(sessionsChoose(entry("b"), "a", false)).toEqual({
      kind: "switch",
      id: "b",
      reopen: false,
    });
    expect(sessionsChoose(entry("c", { archived: true }), "a", false)).toEqual({
      kind: "switch",
      id: "c",
      reopen: true,
    });
  });
});

describe("sessionsDelete", () => {
  test("first x arms, a second on the same row deletes; a move disarms; the current row is refused", () => {
    // Mutation: delete on the first press → no "arm".
    const armed = sessionsDelete(SESSIONS_START, entry("b"), "a");
    expect(armed).toEqual({ kind: "arm", state: { cursor: 0, armed: "b" } });
    expect(sessionsDelete(armed.state, entry("b"), "a")).toEqual({
      kind: "delete",
      id: "b",
      state: { cursor: 0, armed: null },
    });
    // Armed on another row: arms this one instead of deleting.
    expect(sessionsDelete(armed.state, entry("c"), "a")).toMatchObject({ kind: "arm" });
    expect(sessionsDelete(SESSIONS_START, entry("a"), "a")).toMatchObject({
      kind: "refused",
      text: "_This is the session you are in — /close it first._",
    });
    const panel = {
      ...sessionsPanel(NOW, { sessions: [entry("a"), entry("b")], more: false }),
    };
    const moved = applyPanel(
      panel.kind === "sessions" ? { ...panel, state: armed.state } : panel,
      "down",
      80,
    );
    expect(moved.kind === "sessions" ? moved.state : null).toEqual({ cursor: 1, armed: null });
  });
});

describe("panel.ts dispatch for the sessions kind", () => {
  test("the view, a move, a click on a row, and the entry under the cursor", () => {
    const data = { sessions: [entry("a"), entry("b"), entry("c")], more: false };
    const panel = sessionsPanel(NOW, data);
    const view = panelView(panel, 80, 10, "a");
    expect(view.rows).toHaveLength(3);
    // The live id passed in marks its row (Review R3-1: never stored in the panel).
    expect(view.rows[0]?.text).toContain("current");
    expect(panelView(panel, 80, 10, "c").rows[2]?.text).toContain("current");
    const clicked = panelClick(panel, view, 2, 80);
    expect(clicked.kind === "sessions" ? sessionsAt(clicked.data, clicked.state)?.id : null).toBe(
      "c",
    );
    const up = applyPanel(panel, "up", 80);
    expect(up.kind === "sessions" ? up.state.cursor : null).toBe(2); // wraps
    // Tree actions that mean nothing here leave it as is.
    expect(applyPanel(panel, "toggle", 80)).toBe(panel);
  });
});

describe("a switch in flight (Review R1)", () => {
  test("sessionsChoose refuses any row while switching, even before the busy and current checks", () => {
    // Mutation: ignore `switching` → a second switch.
    expect(sessionsChoose(entry("b"), "a", false, true)).toEqual({
      kind: "refused",
      text: SWITCHING_NOTICE,
    });
    expect(sessionsChoose(entry("b"), "a", false, false)).toMatchObject({ kind: "switch" });
  });

  test("switchingRefusal: prompts and the session-acting commands are refused; reads and /exit are not", () => {
    expect(switchingRefusal(true, { kind: "prompt" })).toBe(SWITCHING_PROMPT_NOTICE);
    for (const name of ["/clear", "/close", "/retry", "/compact", "/rename", "/sessions"]) {
      expect(switchingRefusal(true, { kind: "command", name })).toBe(SWITCHING_NOTICE);
    }
    for (const name of ["/exit", "/quit", "/help", "/tokens", "/copy"]) {
      expect(switchingRefusal(true, { kind: "command", name })).toBeNull();
    }
    expect(switchingRefusal(false, { kind: "prompt" })).toBeNull();
    expect(switchingRefusal(false, { kind: "command", name: "/close" })).toBeNull();
  });
});

describe("a delete's refresh (Review R3-1)", () => {
  test("applies only to the same, still-open sessions panel, with no switch in flight", () => {
    const base = { startedGen: 3, gen: 3, open: true, switching: false };
    expect(sessionsRefreshApplies(base)).toBe(true);
    expect(sessionsRefreshApplies({ ...base, gen: 4 })).toBe(false); // closed / another panel since
    expect(sessionsRefreshApplies({ ...base, open: false })).toBe(false);
    expect(sessionsRefreshApplies({ ...base, switching: true })).toBe(false);
  });

  test("the refreshed state keeps the cursor in range and drops an armed delete", () => {
    const view = { sessions: [entry("a"), entry("b")], more: false };
    expect(refreshedSessions({ cursor: 2, armed: "c" }, view)).toEqual({ cursor: 1, armed: null });
    expect(refreshedSessions({ cursor: 0, armed: null }, { sessions: [], more: false })).toEqual({
      cursor: 0,
      armed: null,
    });
  });
});
