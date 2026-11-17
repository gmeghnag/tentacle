/**
 * Where a drawer pick navigates (docs/feat/mobile-chrome.md Design 3, F4,
 * slice S5): the same computer replaces the Session route (no stack growth);
 * another computer resets the stack to `[Computers, Sessions(B), Session(B,x)]`
 * so the edge back-swipe lands on the RIGHT computer's list; an archived pick
 * keeps `archived: true` (Owner Q4: browsing never revives).
 */
import { describe, expect, test } from "bun:test";
import { type DrawerPick, drawerSearchTarget, drawerTarget } from "../src/drawer-nav.ts";
import type { SessionRoute } from "../src/routes.ts";

const FROM: SessionRoute = { computerId: "a", sessionId: "s1", title: "one", archived: false };

function pick(over: Partial<DrawerPick> = {}): DrawerPick {
  return {
    computerId: "a",
    computerName: "Mac a",
    sessionId: "s2",
    title: "two",
    archived: false,
    ...over,
  };
}

describe("drawerTarget", () => {
  test("same computer: replace the Session route", () => {
    expect(drawerTarget(FROM, pick())).toEqual({
      kind: "replace",
      route: {
        name: "Session",
        params: { computerId: "a", sessionId: "s2", title: "two", archived: false },
      },
    });
  });

  test("another computer: reset to Computers → Sessions(B) → Session(B, x) (F4)", () => {
    expect(drawerTarget(FROM, pick({ computerId: "b", computerName: "Mac b" }))).toEqual({
      kind: "reset",
      routes: [
        { name: "Computers" },
        { name: "Sessions", params: { computerId: "b", name: "Mac b" } },
        {
          name: "Session",
          params: { computerId: "b", sessionId: "s2", title: "two", archived: false },
        },
      ],
    });
  });

  test("an archived pick keeps archived: true, on either path (never reopen)", () => {
    const same = drawerTarget(FROM, pick({ archived: true }));
    expect(same.kind === "replace" && same.route.name === "Session" && same.route.params).toEqual({
      computerId: "a",
      sessionId: "s2",
      title: "two",
      archived: true,
    });
    const other = drawerTarget(FROM, pick({ computerId: "b", archived: true }));
    const last = other.kind === "reset" ? other.routes[other.routes.length - 1] : undefined;
    expect(last?.name === "Session" && last.params.archived).toBe(true);
  });

  test("the open session itself: stay (no remount, no detach)", () => {
    expect(drawerTarget(FROM, pick({ sessionId: "s1" }))).toEqual({ kind: "stay" });
  });

  test("the same session id on ANOTHER computer is a different session", () => {
    expect(drawerTarget(FROM, pick({ computerId: "b", sessionId: "s1" })).kind).toBe("reset");
  });

  test("the row's cwd rides the route (the header's folder); none → no key", () => {
    const withCwd = drawerTarget(FROM, pick({ cwd: "/srv/app" }));
    expect(withCwd.kind === "replace" && withCwd.route.name === "Session" && withCwd.route.params)
      .toMatchObject({ sessionId: "s2", cwd: "/srv/app" });
    const empty = drawerTarget(FROM, pick({ cwd: "" }));
    expect(empty.kind === "replace" && "cwd" in empty.route.params).toBe(false);
  });
});

describe("drawerSearchTarget (the magnifier)", () => {
  test("the listed computer's Sessions screen, search focused, under Computers", () => {
    expect(drawerSearchTarget("b", "Mac b")).toEqual([
      { name: "Computers" },
      { name: "Sessions", params: { computerId: "b", name: "Mac b", search: true } },
    ]);
  });
});

describe("drawerTarget for a session just created (New session, S7)", () => {
  test("a fresh pick opens with the composer focused, on either path; an ordinary pick never does", () => {
    const same = drawerTarget(FROM, pick({ sessionId: "new-1", focus: true }));
    expect(same.kind === "replace" ? same.route.params.focus : undefined).toBe(true);
    const other = drawerTarget(FROM, pick({ computerId: "b", sessionId: "new-2", focus: true }));
    expect(other.kind === "reset" ? other.routes.at(-1) : undefined).toEqual({
      name: "Session",
      params: { computerId: "b", sessionId: "new-2", title: "two", archived: false, focus: true },
    });
    const plain = drawerTarget(FROM, pick());
    expect(plain.kind === "replace" ? "focus" in plain.route.params : true).toBe(false);
  });
});
