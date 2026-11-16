/**
 * The sessions drawer's list and title (docs/feat/mobile-chrome.md Design 3,
 * slice S5): Running / Recent / Archived · n, the current row highlighted by
 * id (never by order), the archived section auto-expanded for an archived open
 * session, and the controller's stale/error passed through (F2: never an empty
 * list that reads "no sessions" when the read failed).
 */
import { describe, expect, test } from "bun:test";
import type { ComputerRow } from "../src/computer-rows.ts";
import { type DrawerSource, drawerList, drawerTitle } from "../src/drawer-list.ts";
import type { SessionRow } from "../src/session-list.ts";

function row(sessionId: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    title: `t-${sessionId}`,
    subtitle: "3m ago",
    badges: [],
    wakes: 0,
    archived: false,
    running: false,
    attached: 0,
    ...over,
  };
}

function source(rows: readonly SessionRow[], over: Partial<DrawerSource> = {}): DrawerSource {
  return {
    status: "loaded",
    stale: false,
    empty: rows.length === 0,
    sections: {
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
