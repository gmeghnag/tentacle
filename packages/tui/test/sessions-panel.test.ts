import { describe, expect, test } from "bun:test";
import { applyPanel, panelClick, panelView, sessionsPanel } from "../src/panel.ts";
import {
  SESSIONS_START,
  SWITCHING_NOTICE,
  SWITCHING_PROMPT_NOTICE,
  SWITCH_BUSY_NOTICE,
  type SessionsEntry,
  refreshedSessions,
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
