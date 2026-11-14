/**
 * Drafts over 13b's store (docs/feat/mobile-compose.md 13d, D4): the per-session
 * field text and photo copies, written debounced (13b's `createDraftScheduler`
 * policy) and forced on the acts nobody can undo (leaving, backgrounding, an item
 * created from the field, a hand-back).
 *
 * Pure of React and of Expo: the timer is injected, so the debounce is tested
 * without a clock, and the file is 13b's (`OutboxStore.setDrafts`), so one
 * computer has one atomic file.
 */
import { describe, expect, test } from "bun:test";
import { type DraftContent, createDraftScheduler } from "../src/drafts.ts";
import { createDraftStore } from "../src/outbox-drafts.ts";
import type { OutboxFs, OutboxStore } from "../src/outbox-store.ts";
import { createOutboxStore, outboxPaths } from "../src/outbox-store.ts";

function memoryFs(): OutboxFs {
  const files = new Map<string, string>();
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) {
        throw new Error("missing");
      }
      files.delete(from);
      files.set(to, text);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
  };
}

/** A clock and a timer the test fires by hand (the debounce is a policy, not a wait). */
function manualClock() {
  let at = 1000;
  const due: (() => void)[] = [];
  return {
    now: () => at,
    timer: {
      schedule(fn: () => void, ms: number) {
        due.push(fn);
        at += ms;
        return { cancel: () => {} };
      },
    },
    /** Fire every armed timer (its own write, then the next arm). */
    async fire() {
      const pending = due.splice(0);
      for (const fn of pending) {
        fn();
      }
      await settle();
    },
    get armed() {
      return due.length;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

async function harness() {
  const clock = manualClock();
  const store: OutboxStore = createOutboxStore(
    memoryFs(),
    outboxPaths("file:///o", "c1"),
    clock.now,
  );
  await store.load();
  const drafts = createDraftStore(store, clock.now, clock.timer, 400);
  return { store, drafts, clock };
}

const CONTENT: DraftContent = { text: "half written", photos: [] };

describe("a draft survives a kill (decision 16)", () => {
  test("a keystroke is written after the debounce, and read back", async () => {
    const h = await harness();
    h.drafts.touch("c1", "s1", CONTENT);
    expect(h.drafts.read("c1", "s1").text).toBe(""); // still pending
    await h.clock.fire();
    expect(h.drafts.read("c1", "s1").text).toBe("half written");
    // It is IN THE FILE, not only in memory: a relaunch reads it from there.
    expect(h.store.data.drafts).toHaveLength(1);
  });

  test("FORCED writes land at once (the app going to the background)", async () => {
    const h = await harness();
    h.drafts.force("c1", "s1", CONTENT);
    await settle();
    expect(h.drafts.read("c1", "s1").text).toBe("half written");
  });

  test("an empty draft is REMOVED, not written (a cleared field is a real state)", async () => {
    const h = await harness();
    h.drafts.force("c1", "s1", CONTENT);
    await settle();
    h.drafts.force("c1", "s1", { text: "", photos: [] });
    await settle();
    expect(h.store.data.drafts).toEqual([]);
    expect(h.drafts.read("c1", "s1")).toEqual({ text: "", photos: [] });
  });

  test("chips alone are a draft too (a photo the person added is work)", async () => {
    const h = await harness();
    h.drafts.force("c1", "s1", { text: "", photos: ["file:///o/photos/a.jpg"] });
    await settle();
    expect(h.drafts.read("c1", "s1").photos).toEqual(["file:///o/photos/a.jpg"]);
  });

  test("two sessions of one computer are two drafts", async () => {
    const h = await harness();
    h.drafts.force("c1", "s1", { text: "one", photos: [] });
    await settle();
    h.drafts.force("c1", "s2", { text: "two", photos: [] });
    await settle();
    expect(h.drafts.read("c1", "s1").text).toBe("one");
    expect(h.drafts.read("c1", "s2").text).toBe("two");
  });

  test("flush() writes what is pending without waiting for a timer", async () => {
    // The app backgrounded (`AppState`): the words must be on disk before iOS
    // suspends the JS thread, so no timer is trusted.
    const h = await harness();
    h.drafts.touch("c1", "s1", CONTENT);
    await h.drafts.flush();
    expect(h.drafts.read("c1", "s1").text).toBe("half written");
  });
});

describe("the debounce keeps its own policy (13b's scheduler)", () => {
  test("a keystroke re-arms: the LAST content is what lands", async () => {
    const h = await harness();
    h.drafts.touch("c1", "s1", { text: "a", photos: [] });
    h.drafts.touch("c1", "s1", { text: "ab", photos: [] });
    await h.clock.fire();
    expect(h.drafts.read("c1", "s1").text).toBe("ab");
    // The scheduler is 13b's, unchanged: this pins the wiring, not the policy.
    expect(createDraftScheduler(() => 0).dueIn(0)).toBeNull();
  });
});
