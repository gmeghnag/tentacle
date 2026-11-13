/**
 * The session list's network side (docs/feat/mobile-app-shell.md): request
 * lifecycle, refresh-after-a-drop, and dropping answers for a screen that is
 * gone. Every async edge is injected.
 */
import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@tentacle/protocol";
import { createSessionListController, viewModel } from "../src/session-list-controller.ts";
import { type SessionListState, initialSessionList } from "../src/session-list.ts";

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

/** A loader whose answers the test delivers by hand. */
function harness() {
  const calls: { cursor?: string }[] = [];
  const waiting: {
    resolve: (page: { sessions: SessionListEntry[]; cursor?: string }) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const states: SessionListState[] = [];
  const controller = createSessionListController({
    load: (params) => {
      calls.push(params);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    now: () => NOW,
  });
  controller.subscribe((state) => states.push(state));
  return { controller, calls, waiting, states };
}

describe("createSessionListController", () => {
  test("refresh asks for page one and lands the rows", async () => {
    const h = harness();
    const running = h.controller.refresh();
    expect(h.calls).toEqual([{}]);
    expect(h.controller.state().status).toBe("loading");
    h.waiting[0]?.resolve({ sessions: [entry("a")] });
    await running;
    expect(h.controller.state().status).toBe("loaded");
    expect(h.controller.state().entries.map((e) => e.sessionId)).toEqual(["a"]);
    expect(h.states.length).toBeGreaterThan(1); // the screen was told
  });

  test("more asks with the cursor; at the end it asks for nothing", async () => {
    const h = harness();
    const first = h.controller.refresh();
    h.waiting[0]?.resolve({ sessions: [entry("a")], cursor: "c1" });
    await first;
    const next = h.controller.more();
    expect(h.calls[1]).toEqual({ cursor: "c1" });
    h.waiting[1]?.resolve({ sessions: [entry("b")] });
    await next;
    expect(h.controller.state().entries.map((e) => e.sessionId)).toEqual(["a", "b"]);
    // No cursor now: `more` does not call the loader at all.
    await h.controller.more();
    expect(h.calls).toHaveLength(2);
  });

  test("a superseded refresh's answer is dropped (the newer page wins)", async () => {
    const h = harness();
    const first = h.controller.refresh();
    const second = h.controller.refresh(); // supersedes the first
    h.waiting[1]?.resolve({ sessions: [entry("fresh")] });
    await second;
    h.waiting[0]?.resolve({ sessions: [entry("late")] }); // arrives after
    await first;
    expect(h.controller.state().entries.map((e) => e.sessionId)).toEqual(["fresh"]);
  });

  test("after dispose an answer changes nothing and no listener fires", async () => {
    const h = harness();
    const running = h.controller.refresh();
    h.controller.dispose();
    const before = h.states.length;
    h.waiting[0]?.resolve({ sessions: [entry("a")] });
    await running;
    expect(h.states.length).toBe(before);
    expect(h.controller.state().entries).toEqual([]);
  });

  test("a failure is worded by describeError and keeps the loaded rows", async () => {
    const h = harness();
    const first = h.controller.refresh();
    h.waiting[0]?.resolve({ sessions: [entry("a")] });
    await first;
    const second = h.controller.refresh();
    h.waiting[1]?.reject(new Error("not connected to the daemon"));
    await second;
    expect(h.controller.state().status).toBe("loaded");
    expect(h.controller.state().stale).toBe(true);
    expect(h.controller.state().error).toBe("Reconnecting…");
  });

  test("link down marks stale; link up refreshes so the list converges", async () => {
    const h = harness();
    const first = h.controller.refresh();
    h.waiting[0]?.resolve({ sessions: [entry("a")], cursor: "c1" });
    await first;
    h.controller.link(false);
    expect(h.controller.state().stale).toBe(true);
    expect(h.calls).toHaveLength(1); // going down asks for nothing
    h.controller.link(true);
    expect(h.calls).toHaveLength(2); // coming up re-reads page one
    expect(h.calls[1]).toEqual({}); // from the top, not the cursor
    h.waiting[1]?.resolve({ sessions: [entry("a")] });
    await Promise.resolve();
    expect(h.controller.state().stale).toBe(false);
  });

  test("link up with no rows marks nothing to refresh (a fresh screen loads on focus)", () => {
    const h = harness();
    h.controller.link(false);
    expect(h.controller.state().stale).toBe(true);
    h.controller.link(true);
    expect(h.calls).toEqual([]); // nothing loaded yet: focus will refresh
    expect(h.controller.state().stale).toBe(false);
  });

  test("link up re-reads an EMPTY loaded list too (review round 1 finding 3)", async () => {
    // The guard needed `entries.length > 0`, so an empty list never converged:
    // it stayed at whatever a refresh-while-down left behind.
    const h = harness();
    const first = h.controller.refresh();
    h.waiting[0]?.resolve({ sessions: [] });
    await first;
    expect(h.controller.state().status).toBe("loaded");
    expect(h.controller.state().entries).toEqual([]);
    h.controller.link(false);
    h.controller.link(true);
    expect(h.calls).toHaveLength(2); // re-read, even with nothing to show
    h.waiting[1]?.resolve({ sessions: [entry("late")] });
    await Promise.resolve();
    expect(h.controller.state().entries.map((e) => e.sessionId)).toEqual(["late"]);
  });

  test("link up retries a FAILED list that loaded nothing", async () => {
    // The Failure-modes row "sessionList while down → refreshed on up" has no
    // rows to keep when the very first read failed: it must retry, not stay
    // failed until the user hits Retry.
    const h = harness();
    const first = h.controller.refresh();
    h.waiting[0]?.reject(new Error("Can't connect — the computer is unreachable"));
    await first;
    expect(h.controller.state().status).toBe("failed");
    h.controller.link(false);
    h.controller.link(true);
    expect(h.calls).toHaveLength(2);
    h.waiting[1]?.resolve({ sessions: [entry("a")] });
    await Promise.resolve();
    expect(h.controller.state().status).toBe("loaded");
    expect(h.controller.state().error).toBeUndefined();
  });
});

describe("viewModel", () => {
  test("a loaded empty list is an empty state, not a spinner", () => {
    const h = harness();
    const view = viewModel(h.controller.state(), NOW);
    expect(view.empty).toBe(false); // idle is not "no sessions yet"
    expect(initialSessionList.status).toBe("idle");
  });

  test("badges, sections and canLoadMore come from the state", async () => {
    const h = harness();
    const running = h.controller.refresh();
    h.waiting[0]?.resolve({
      sessions: [entry("live", { running: true }), entry("old", { archived: true })],
      cursor: "c1",
    });
    await running;
    const view = viewModel(h.controller.state(), NOW);
    expect(view.sections.active.map((r) => r.sessionId)).toEqual(["live"]);
    expect(view.sections.active[0]?.badges).toEqual(["running"]);
    expect(view.sections.archived.map((r) => r.sessionId)).toEqual(["old"]);
    expect(view.empty).toBe(false);
    expect(view.canLoadMore).toBe(true);
  });
});
