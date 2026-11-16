/**
 * The drawer's local UI state (docs/feat/mobile-chrome.md Design 3, slice S5):
 * open/close, the computer the drawer LISTS (local, not persisted — every open
 * restarts on the open session's computer), the archived toggle (reset by a
 * computer switch) and the computer menu.
 */
import { describe, expect, test } from "bun:test";
import {
  type DrawerState,
  drawerCurrentId,
  drawerReducer,
  initialDrawer,
} from "../src/drawer-nav.ts";
import type { SessionRoute } from "../src/routes.ts";

describe("drawerReducer", () => {
  test("starts closed on the open session's computer, archived on auto", () => {
    expect(initialDrawer("a")).toEqual({
      open: false,
      computerId: "a",
      archivedOpen: null,
      menuOpen: false,
    });
  });

  test("open, then close; close also shuts the computer menu", () => {
    const opened = drawerReducer(initialDrawer("a"), { type: "open", computerId: "a" });
    expect(opened.open).toBe(true);
    const menu = drawerReducer(opened, { type: "menu", open: true });
    expect(menu.menuOpen).toBe(true);
    const closed = drawerReducer(menu, { type: "close" });
    expect(closed.open).toBe(false);
    expect(closed.menuOpen).toBe(false);
  });

  test("selecting a computer lists it, resets the archived toggle, shuts the menu", () => {
    let s: DrawerState = drawerReducer(initialDrawer("a"), { type: "open", computerId: "a" });
    s = drawerReducer(s, { type: "toggle-archived", shown: false });
    expect(s.archivedOpen).toBe(true);
    s = drawerReducer(s, { type: "menu", open: true });
    s = drawerReducer(s, { type: "select-computer", computerId: "b" });
    expect(s).toEqual({ open: true, computerId: "b", archivedOpen: null, menuOpen: false });
  });

  test("reopening restarts on the open session's computer (the pick is not persisted)", () => {
    let s: DrawerState = drawerReducer(initialDrawer("a"), { type: "open", computerId: "a" });
    s = drawerReducer(s, { type: "select-computer", computerId: "b" });
    s = drawerReducer(s, { type: "toggle-archived", shown: false });
    s = drawerReducer(s, { type: "close" });
    s = drawerReducer(s, { type: "open", computerId: "a" });
    expect(s).toEqual({ open: true, computerId: "a", archivedOpen: null, menuOpen: false });
  });

  test("the archived toggle flips what is SHOWN (an auto-expanded section can be collapsed)", () => {
    const s = drawerReducer(initialDrawer("a"), { type: "open", computerId: "a" });
    expect(drawerReducer(s, { type: "toggle-archived", shown: true }).archivedOpen).toBe(false);
    expect(drawerReducer(s, { type: "toggle-archived", shown: false }).archivedOpen).toBe(true);
  });
});

describe("drawerCurrentId", () => {
  const FROM: SessionRoute = { computerId: "a", sessionId: "s1", title: "one", archived: false };

  test("the open session's id while the drawer lists its own computer", () => {
    const s = drawerReducer(initialDrawer("a"), { type: "open", computerId: "a" });
    expect(drawerCurrentId(s, FROM)).toBe("s1");
  });

  test("another computer listed: nothing highlighted, even on an equal id", () => {
    let s = drawerReducer(initialDrawer("a"), { type: "open", computerId: "a" });
    s = drawerReducer(s, { type: "select-computer", computerId: "b" });
    expect(drawerCurrentId(s, FROM)).toBeNull();
  });
});
