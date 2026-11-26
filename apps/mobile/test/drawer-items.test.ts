/**
 * The drawer's render list, computer menu and motion (docs/feat/mobile-chrome.md
 * Design 3, F2/F5/F11, slice S6). The component maps `drawerItems` 1:1 to
 * elements, so every "is this shown" decision is pinned here (AGENTS §7): a
 * failed or stale read is said, never "no sessions"; empty sections are not
 * drawn; Archived · n is one toggle row whose rows follow only when open;
 * Load more only while the controller can page.
 */
import { describe, expect, test } from "bun:test";
import type { ComputerRow } from "../src/computer-rows.ts";
import {
  type DrawerList,
  type DrawerRow,
  drawerComputers,
  drawerItems,
} from "../src/drawer-list.ts";
import { DRAWER_WIDTH, drawerMotion, swipeCloses, swipeIsHorizontal } from "../src/drawer-nav.ts";

function r(id: string, over: Partial<DrawerRow> = {}): DrawerRow {
  return {
    id,
    title: id,
    folder: "",
    cwd: "",
    meta: "",
    tone: "idle",
    archived: false,
    current: false,
    running: false,
    attached: 0,
    pinned: false,
    marks: { ask: false, workflow: false, wake: false },
    ...over,
  };
}

function list(over: Partial<DrawerList> = {}): DrawerList {
  return {
    pinned: [],
    running: [],
    recent: [],
    archived: { count: 0, rows: null },
    currentIn: null,
    status: "loaded",
    stale: false,
    empty: false,
    canLoadMore: false,
    nextAfterCurrent: null,
    ...over,
  };
}

const kinds = (l: DrawerList) => drawerItems(l).map((item) => item.kind);

describe("drawerItems", () => {
  test("sections in order, labels only for non-empty ones", () => {
    const items = drawerItems(
      list({ running: [r("a", { tone: "running" })], recent: [r("b"), r("c")] }),
    );
    expect(items.map((i) => i.kind)).toEqual(["label", "row", "label", "row", "row"]);
    expect(items[0]).toMatchObject({ kind: "label", text: "Running" });
    expect(items[2]).toMatchObject({ kind: "label", text: "Recent" });
    expect(kinds(list({ recent: [r("b")] }))).toEqual(["label", "row"]);
  });

  test("Archived · n is one toggle; its rows follow only when open", () => {
    const closed = drawerItems(list({ recent: [r("b")], archived: { count: 2, rows: null } }));
    expect(closed.map((i) => i.kind)).toEqual(["label", "row", "archived"]);
    expect(closed[2]).toMatchObject({ kind: "archived", count: 2, open: false });
    const open = drawerItems(
      list({ archived: { count: 1, rows: [r("z", { archived: true, tone: "archived" })] } }),
    );
    expect(open.map((i) => i.kind)).toEqual(["archived", "row"]);
    expect(open[0]).toMatchObject({ open: true });
    expect(kinds(list({ archived: { count: 0, rows: null } }))).toEqual([]);
  });

  test("Load more only while the controller can page", () => {
    expect(kinds(list({ recent: [r("b")], canLoadMore: true }))).toEqual(["label", "row", "more"]);
    expect(kinds(list({ recent: [r("b")] }))).toEqual(["label", "row"]);
  });

  test("F2: a failed first read is an error with its text, never 'empty'", () => {
    const items = drawerItems(list({ status: "failed", stale: true, error: "Offline" }));
    expect(items.map((i) => i.kind)).toEqual(["error"]);
    expect(items[0]).toMatchObject({ text: "Offline" });
    expect(drawerItems(list({ status: "failed" }))[0]).toMatchObject({
      kind: "error",
      text: "Something went wrong",
    });
  });

  test("F2: a stale list keeps its rows under a stale notice", () => {
    const items = drawerItems(
      list({ status: "loaded", stale: true, error: "Offline", recent: [r("b")] }),
    );
    expect(items.map((i) => i.kind)).toEqual(["stale", "label", "row"]);
    expect(items[0]).toMatchObject({ text: "Offline" });
    expect(drawerItems(list({ stale: true, recent: [r("b")] }))[0]).toMatchObject({
      text: "Showing the last list this phone saw.",
    });
  });

  test("loading with nothing yet; empty only when the list says so", () => {
    expect(kinds(list({ status: "loading" }))).toEqual(["loading"]);
    expect(kinds(list({ status: "idle" }))).toEqual(["loading"]);
    expect(kinds(list({ empty: true }))).toEqual(["empty"]);
    // A loading refresh over rows we already have keeps the rows, no spinner row.
    expect(kinds(list({ status: "loading", recent: [r("b")] }))).toEqual(["label", "row"]);
  });

  test("keys are unique (one FlatList)", () => {
    const items = drawerItems(
      list({
        running: [r("a")],
        recent: [r("b")],
        archived: { count: 1, rows: [r("c", { archived: true })] },
        canLoadMore: true,
        stale: true,
      }),
    );
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

function crow(id: string, state: ComputerRow["state"]): ComputerRow {
  return { id, name: `row-${id}`, project: `p-${id}`, status: "", state };
}

describe("drawerComputers (the computer menu)", () => {
  const records = [
    { id: "a", name: "Mac" },
    { id: "b", name: "Box" },
  ];

  test("every paired computer, in record order, the selected one checked", () => {
    const items = drawerComputers(records, [crow("a", "ok"), crow("b", "unreachable")], "b");
    expect(items).toEqual([
      { id: "a", name: "Mac", tone: "online", status: "Online", checked: false },
      { id: "b", name: "Box", tone: "offline", status: "Offline", checked: true },
    ]);
  });

  test("a computer not probed yet says Connecting…, never Online", () => {
    const items = drawerComputers(records, [crow("a", "ok")], "a");
    expect(items[1]).toEqual({
      id: "b",
      name: "Box",
      tone: "offline",
      status: "Connecting…",
      checked: false,
    });
  });

  test("a computer needing pairing again is attention", () => {
    expect(drawerComputers(records, [crow("a", "revoked")], "a")[0]?.tone).toBe("attention");
  });
});

describe("drawer motion and swipe (F11, Design 3)", () => {
  test("Reduce Motion: fade only, no translate", () => {
    expect(drawerMotion(true)).toEqual({ slide: 0, duration: 220 });
    expect(drawerMotion(false)).toEqual({ slide: DRAWER_WIDTH, duration: 220 });
    expect(DRAWER_WIDTH).toBe(300);
  });

  test("only a horizontal move is the panel's", () => {
    expect(swipeIsHorizontal(-20, 5)).toBe(true);
    expect(swipeIsHorizontal(-5, 20)).toBe(false);
    expect(swipeIsHorizontal(3, 1)).toBe(false);
  });

  test("a left swipe past the threshold closes; right or short does not", () => {
    expect(swipeCloses(-60, 10)).toBe(true);
    expect(swipeCloses(-30, 0)).toBe(false);
    expect(swipeCloses(80, 0)).toBe(false);
    expect(swipeCloses(-60, 90)).toBe(false);
  });
});

describe("the Pinned section's row (docs/feat/mobile-session-actions.md S2)", () => {
  test("Pinned is drawn first, above Running, and only when non-empty", () => {
    const pinned = r("p", { pinned: true });
    const items = drawerItems(
      list({ pinned: [pinned], running: [r("a", { tone: "running" })], recent: [r("b")] }),
    );
    expect(items.slice(0, 2).map((i) => (i.kind === "label" ? i.text : i.kind))).toEqual([
      "Pinned",
      "row",
    ]);
    expect(items[1 as number]).toMatchObject({ kind: "row", row: { id: "p" } });
    expect(items.map((i) => i.kind)).toEqual(["label", "row", "label", "row", "label", "row"]);
    expect(kinds(list({ running: [r("a")] }))).toEqual(["label", "row"]);
  });

  test("a pinned row is one row: it is not drawn again under Running", () => {
    const items = drawerItems(list({ pinned: [r("p", { pinned: true })], running: [] }));
    expect(items.filter((i) => i.kind === "row").map((i) => i.kind === "row" && i.row.id)).toEqual([
      "p",
    ]);
  });
});
