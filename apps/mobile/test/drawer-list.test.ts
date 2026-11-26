/**
 * The sessions drawer's list and title (docs/feat/mobile-chrome.md Design 3,
 * slice S5): Running / Recent / Archived · n, the current row highlighted by
 * id (never by order), the archived section auto-expanded for an archived open
 * session, and the controller's stale/error passed through (F2: never an empty
 * list that reads "no sessions" when the read failed).
 */
import { describe, expect, test } from "bun:test";
import { DomainErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { type ComputerRow, computerRow } from "../src/computer-rows.ts";
import { type DrawerSource, drawerList, drawerTitle, rowMarks } from "../src/drawer-list.ts";
import type { SessionRow } from "../src/session-list.ts";

function row(sessionId: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    title: `t-${sessionId}`,
    cwd: "/work/alpha",
    subtitle: "3m ago",
    badges: [],
    wakes: 0,
    asks: 0,
    workflows: 0,
    archived: false,
    running: false,
    attached: 0,
    pinned: false,
    ...over,
  };
}

function source(rows: readonly SessionRow[], over: Partial<DrawerSource> = {}): DrawerSource {
  return {
    status: "loaded",
    stale: false,
    empty: rows.length === 0,
    sections: {
      pinned: rows.filter((r) => r.pinned),
      active: rows.filter((r) => !r.archived),
      archived: rows.filter((r) => r.archived),
    },
    canLoadMore: false,
    ...over,
  };
}

const ROWS = [
  row("r1", { running: true, attached: 2 }),
  row("i1"),
  row("i2"),
  row("a1", { archived: true }),
  row("a2", { archived: true }),
];

const closed = { currentId: null, archivedOpen: null } as const;

describe("drawerList", () => {
  test("splits running and recent, keeps the daemon's order, counts archived", () => {
    const list = drawerList(source(ROWS), closed);
    expect(list.running.map((r) => r.id)).toEqual(["r1"]);
    expect(list.recent.map((r) => r.id)).toEqual(["i1", "i2"]);
    expect(list.archived.count).toBe(2);
    expect(list.archived.rows).toBeNull(); // collapsed by default
    expect(list.running[0]?.meta).toBe("Running · 2 attached · 3m ago");
    expect(list.running[0]?.tone).toBe("running");
    expect(list.recent[0]?.meta).toBe("3m ago");
    expect(list.recent[0]?.tone).toBe("idle");
    expect(list.currentIn).toBeNull();
  });

  test("highlights the current row in each section, by id", () => {
    for (const [id, section] of [
      ["r1", "running"],
      ["i2", "recent"],
      ["a2", "archived"],
    ] as const) {
      const list = drawerList(source(ROWS), { currentId: id, archivedOpen: null });
      expect(list.currentIn).toBe(section);
      const all = [...list.running, ...list.recent, ...(list.archived.rows ?? [])];
      expect(all.filter((r) => r.current).map((r) => r.id)).toEqual([id]);
    }
  });

  test("current absent from the loaded pages (F5): no highlight, nothing invented", () => {
    const list = drawerList(source(ROWS), { currentId: "older", archivedOpen: null });
    expect(list.currentIn).toBeNull();
    const all = [...list.running, ...list.recent];
    expect(all.some((r) => r.current)).toBe(false);
    expect(all).toHaveLength(3);
  });

  test("archived: collapsed, expanded by the toggle, auto-expanded for an archived current", () => {
    expect(drawerList(source(ROWS), closed).archived.rows).toBeNull();
    const opened = drawerList(source(ROWS), { currentId: null, archivedOpen: true });
    expect(opened.archived.rows?.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(opened.archived.rows?.[0]?.tone).toBe("archived");
    expect(opened.archived.rows?.[0]?.archived).toBe(true);
    const auto = drawerList(source(ROWS), { currentId: "a1", archivedOpen: null });
    expect(auto.archived.rows?.map((r) => r.id)).toEqual(["a1", "a2"]);
    // The person collapsed it explicitly: respected even with an archived current.
    const shut = drawerList(source(ROWS), { currentId: "a1", archivedOpen: false });
    expect(shut.archived.rows).toBeNull();
    expect(shut.currentIn).toBe("archived");
  });

  test("an empty computer is empty; a failed or stale read is not (F2)", () => {
    const empty = drawerList(source([]), closed);
    expect(empty.empty).toBe(true);
    expect(empty.archived).toEqual({ count: 0, rows: null });
    const failed = drawerList(
      source([], { status: "failed", stale: true, empty: false, error: "Can't connect" }),
      closed,
    );
    expect(failed.empty).toBe(false);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Can't connect");
    expect(failed.stale).toBe(true);
    // Link down over an empty list read earlier: stale, never "no sessions".
    const staleEmpty = drawerList(source([], { stale: true }), closed);
    expect(staleEmpty.empty).toBe(false);
    expect(staleEmpty.stale).toBe(true);
  });

  test("rows read before a failed refresh stay, marked stale, with the error; paging passes through", () => {
    const list = drawerList(
      source(ROWS, { stale: true, error: "Can't connect", canLoadMore: true }),
      closed,
    );
    expect(list.recent).toHaveLength(2);
    expect(list.stale).toBe(true);
    expect(list.error).toBe("Can't connect");
    expect(list.canLoadMore).toBe(true);
    expect(drawerList(source(ROWS), closed).error).toBeUndefined();
  });
});

function computer(id: string, over: Partial<ComputerRow> = {}): ComputerRow {
  return { id, name: `Mac ${id}`, project: "proj", status: "", state: "ok", ...over };
}

describe("drawerTitle", () => {
  const A = { id: "a", name: "Mac a" };
  const B = { id: "b", name: "Mac b" };

  test("one paired computer: not switchable", () => {
    const title = drawerTitle([A], [computer("a")], "a");
    expect(title).toEqual({
      name: "Mac a",
      tone: "online",
      status: "Online",
      project: "proj",
      switchable: false,
      canCreate: true,
    });
  });

  test("two paired computers: switchable, the selected one named", () => {
    const title = drawerTitle([A, B], [computer("a"), computer("b")], "b");
    expect(title?.name).toBe("Mac b");
    expect(title?.switchable).toBe(true);
  });

  test("offline: the Computers screen's wording, New session disabled (F2/F8)", () => {
    const title = drawerTitle(
      [A, B],
      [computer("a"), computer("b", { state: "unreachable", status: "Can't connect" })],
      "b",
    );
    expect(title?.tone).toBe("offline");
    expect(title?.status).toBe("Offline");
    expect(title?.canCreate).toBe(false);
  });

  test("a computer that needs pairing again cannot create either", () => {
    const title = drawerTitle([A], [computer("a", { state: "revoked" })], "a");
    expect(title?.tone).toBe("attention");
    expect(title?.canCreate).toBe(false);
  });

  test("a refused protocol skew: «Update the app», never «Online» with New session", () => {
    // The computer ANSWERED and refused `initialize` (docs/fix/mobile-version-mismatch-diagnosis.md
    // Review round 1 finding 1): the link's diagnosis is `ok`, so the row used to
    // read «Online» with the detail "update the app", and the drawer offered New
    // session to a daemon that refuses every `initialize`.
    const skewed = computerRow(
      A,
      {
        ok: false,
        error: new RpcError(DomainErrorCode.VersionMismatch, "protocol version mismatch", {
          client: { protocol: PROTOCOL_VERSION },
          daemon: { protocol: PROTOCOL_VERSION + 2 },
          update: "client",
        }),
      },
      "ok",
    );
    const title = drawerTitle([A], [skewed], "a");
    expect(title?.status).toBe("Update the app");
    expect(title?.tone).toBe("attention");
    expect(title?.canCreate).toBe(false);
  });

  test("not probed yet: Connecting…, named from the paired record", () => {
    const title = drawerTitle([A, B], [], "b");
    expect(title).toEqual({
      name: "Mac b",
      tone: "offline",
      status: "Connecting…",
      project: "",
      switchable: true,
      canCreate: false,
    });
  });

  test("a computer no longer paired: no title (the drawer never invents one)", () => {
    expect(drawerTitle([A], [computer("a")], "gone")).toBeNull();
  });
});

describe("the Pinned section (docs/feat/mobile-session-actions.md S2)", () => {
  /** `source` with a pinned projection over the same rows (the drawer hoists by id). */
  function withPins(pinnedIds: readonly string[], rows: readonly SessionRow[]): DrawerSource {
    const base = source(rows);
    return {
      ...base,
      sections: { ...base.sections, pinned: rows.filter((r) => pinnedIds.includes(r.sessionId)) },
    };
  }

  test("Pinned comes first and its rows leave Running/Recent/Archived (one row each)", () => {
    const list = drawerList(withPins(["i1", "a1"], ROWS), { currentId: null, archivedOpen: true });
    expect(list.pinned.map((r) => r.id)).toEqual(["i1", "a1"]);
    expect(list.running.map((r) => r.id)).toEqual(["r1"]);
    expect(list.recent.map((r) => r.id)).toEqual(["i2"]);
    expect(list.archived.rows?.map((r) => r.id)).toEqual(["a2"]);
  });

  test("a running pinned row keeps its running tone and its place in Pinned", () => {
    const list = drawerList(withPins(["r1"], ROWS), closed);
    expect(list.pinned.map((r) => [r.id, r.tone])).toEqual([["r1", "running"]]);
    expect(list.running).toEqual([]);
  });

  test("a pinned ARCHIVED row shows in Pinned dimmed, and is not counted twice", () => {
    const list = drawerList(withPins(["a1"], ROWS), { currentId: null, archivedOpen: true });
    expect(list.pinned.map((r) => [r.id, r.tone, r.archived])).toEqual([["a1", "archived", true]]);
    expect(list.archived.count).toBe(1);
    expect(list.archived.rows?.map((r) => r.id)).toEqual(["a2"]);
  });

  test("the open session is found in Pinned first (currentIn, F5 never hidden)", () => {
    const list = drawerList(withPins(["i1"], ROWS), { currentId: "i1", archivedOpen: null });
    expect(list.currentIn).toBe("pinned");
    expect(list.pinned[0]?.current).toBe(true);
  });

  test("no pins: the Pinned section is empty and every section is as before", () => {
    const list = drawerList(source(ROWS), closed);
    expect(list.pinned).toEqual([]);
    expect(list.recent.map((r) => r.id)).toEqual(["i1", "i2"]);
  });

  test("an empty list is still empty once pins are projected (nothing invented)", () => {
    const empty = drawerList(
      { ...source([]), sections: { pinned: [], active: [], archived: [] } },
      closed,
    );
    expect(empty.empty).toBe(true);
    expect(empty.pinned).toEqual([]);
  });
});

describe("nextAfterCurrent (the row a delete of the open session lands on, Owner Q2)", () => {
  const PIN = row("p1", { pinned: true });

  function listOf(currentId: string | null, rows: readonly SessionRow[]): string | null {
    const base = source(rows);
    return (
      drawerList(
        { ...base, sections: { ...base.sections, pinned: rows.filter((r) => r.pinned) } },
        { currentId, archivedOpen: null },
      ).nextAfterCurrent?.id ?? null
    );
  }

  test("the first remaining row after it, in the drawer's own visible order", () => {
    expect(listOf("p1", [PIN, row("i1"), row("i2")])).toBe("i1");
    expect(listOf("i1", [PIN, row("i1"), row("i2")])).toBe("i2");
  });

  test("the last row falls back to the first one before it (the list shifts up)", () => {
    expect(listOf("i2", [PIN, row("i1"), row("i2")])).toBe("p1");
  });

  test("archived rows are never 'the next session' (browsing is not a switch)", () => {
    expect(listOf("i1", [row("i1"), row("a1", { archived: true })])).toBeNull();
  });

  test("nothing left → null (the empty drawer with its New session pill)", () => {
    expect(listOf("i1", [row("i1")])).toBeNull();
    expect(listOf(null, [row("i1")])).toBeNull();
  });
});

describe("the drawer row's folder line (docs/feat/mobile-header-status.md)", () => {
  const options = { currentId: null, archivedOpen: null };

  test("the row shows its session's folder, home as ~, middle-cut", () => {
    const deep = "/Users/me/tentacle/.tentacle/worktrees/hop-live/proj";
    const list = drawerList(source([row("r1", { cwd: deep })]), options);
    expect(list.recent.map((r) => r.folder)).toEqual(["~/tentacle/…/hop-live/proj"]);
  });

  test("an empty cwd is no folder line", () => {
    const list = drawerList(source([row("r1", { cwd: "" })]), options);
    expect(list.recent.map((r) => r.folder)).toEqual([""]);
  });
});

describe("rowMarks (mobile-ask-surfaces S7b)", () => {
  const none = { asks: 0, workflows: 0, wakes: 0 };
  test("absent / zero counts draw no glyph", () => {
    expect(rowMarks(none, false)).toEqual({ ask: false, workflow: false, wake: false });
  });
  test("each count lights only its own glyph", () => {
    expect(rowMarks({ ...none, asks: 2 }, false)).toEqual({
      ask: true,
      workflow: false,
      wake: false,
    });
    expect(rowMarks({ ...none, workflows: 1 }, false)).toEqual({
      ask: false,
      workflow: true,
      wake: false,
    });
    expect(rowMarks({ ...none, wakes: 3 }, false)).toEqual({
      ask: false,
      workflow: false,
      wake: true,
    });
  });
  test("the open session's local ask wins over a stale asks: 0", () => {
    expect(rowMarks(none, true).ask).toBe(true);
  });
  test("drawerList: local ask marks ONLY the current row", () => {
    const list = drawerList(source([row("a"), row("b")]), {
      currentId: "b",
      archivedOpen: null,
      currentAsking: true,
    });
    expect(list.recent.map((r) => [r.id, r.marks.ask])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
  test("drawerList: daemon counts reach the row marks", () => {
    const list = drawerList(source([row("a", { asks: 1, workflows: 2, wakes: 1 }), row("b")]), {
      currentId: null,
      archivedOpen: null,
    });
    expect(list.recent[0]?.marks).toEqual({ ask: true, workflow: true, wake: true });
    expect(list.recent[1]?.marks).toEqual({ ask: false, workflow: false, wake: false });
  });
});
