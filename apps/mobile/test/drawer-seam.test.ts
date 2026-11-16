/**
 * The load-bearing check of docs/feat/mobile-chrome.md (slice S5): the drawer
 * needs NO new data path — the per-computer `createSessionListController` +
 * `viewModel` the Sessions screen already uses feed `drawerList` for any
 * paired computer, with only the existing `session/list` loader injected.
 */
import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@tentacle/protocol";
import { drawerList } from "../src/drawer-list.ts";
import { createSessionListController, viewModel } from "../src/session-list-controller.ts";
import type { SessionPage } from "../src/session-list.ts";

const NOW = 1_700_000_000_000;

function entry(sessionId: string, over: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId,
    title: sessionId,
    cwd: "/work/alpha",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 30_000,
    running: false,
    attached: 0,
    archived: false,
    ...over,
  };
}

/** One fake daemon per computer: its `session/list` answer, and who asked. */
const DAEMONS: Record<string, SessionPage> = {
  a: { sessions: [entry("a-run", { running: true, attached: 1 }), entry("a-idle")] },
  b: { sessions: [entry("b-idle"), entry("b-old", { archived: true })] },
};

function controllerFor(computerId: string, calls: string[]) {
  return createSessionListController({
    load: async () => {
      calls.push(computerId);
      const page = DAEMONS[computerId];
      if (page === undefined) {
        throw new Error(`no daemon ${computerId}`);
      }
      return page;
    },
    now: () => NOW,
  });
}

describe("drawer over the existing session-list seam", () => {
  test("two computers, two controllers, the same drawerList — no new client call", async () => {
    const calls: string[] = [];
    const a = controllerFor("a", calls);
    const b = controllerFor("b", calls);
    await a.refresh();
    await b.refresh();
    expect(calls).toEqual(["a", "b"]);

    const listA = drawerList(viewModel(a.state(), NOW), {
      currentId: "a-idle",
      archivedOpen: null,
    });
    expect(listA.running.map((r) => r.id)).toEqual(["a-run"]);
    expect(listA.recent.map((r) => [r.id, r.current])).toEqual([["a-idle", true]]);
    expect(listA.currentIn).toBe("recent");

    // The drawer switched to computer b: its list, with a's open session absent (F5).
    const listB = drawerList(viewModel(b.state(), NOW), {
      currentId: "a-idle",
      archivedOpen: null,
    });
    expect(listB.recent.map((r) => r.id)).toEqual(["b-idle"]);
    expect(listB.archived.count).toBe(1);
    expect(listB.currentIn).toBeNull();
  });

  test("a computer whose daemon fails: the error reaches the drawer, not an empty list (F2)", async () => {
    const c = controllerFor("down", []);
    await c.refresh();
    const list = drawerList(viewModel(c.state(), NOW), { currentId: null, archivedOpen: null });
    expect(list.status).toBe("failed");
    expect(list.empty).toBe(false);
    expect(list.error).toBeDefined();
  });

  test("a late page of a previous open is dropped (F3: refresh on every open)", async () => {
    const waiting: ((page: SessionPage) => void)[] = [];
    const c = createSessionListController({
      load: () => new Promise<SessionPage>((resolve) => waiting.push(resolve)),
      now: () => NOW,
    });
    const first = c.refresh();
    const second = c.refresh(); // the drawer reopened
    waiting[1]?.({ sessions: [entry("fresh")] });
    await second;
    waiting[0]?.({ sessions: [entry("late")] });
    await first;
    const list = drawerList(viewModel(c.state(), NOW), { currentId: null, archivedOpen: null });
    expect(list.recent.map((r) => r.id)).toEqual(["fresh"]);
  });
});
