/**
 * Per-session drafts (docs/feat/mobile-compose.md 13b, D4): the debounce
 * policy, the (computer, session) key, and "an empty draft is a state".
 *
 * The clock is injected, so no test waits for a timer.
 */
import { describe, expect, test } from "bun:test";
import {
  DRAFT_DEBOUNCE_MS,
  type DraftScheduler,
  contentOf,
  createDraftScheduler,
  draftKey,
  draftOf,
  isEmptyDraft,
} from "../src/drafts.ts";

/** A clock a test moves by hand. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

const pendingKeys = (s: DraftScheduler, at: number): readonly string[] =>
  s.take().map((entry) => draftKey(entry.key[0], entry.key[1]));

describe("the draft key", () => {
  test("the same session on two computers is two drafts", () => {
    expect(draftKey("c1", "s1")).not.toBe(draftKey("c2", "s1"));
  });

  test("a joined string would collide: the key is a pair, not a concatenation", () => {
    // "c1" + "2s" and "c12" + "s" join to the same text; the pair does not.
    expect(draftKey("c1", "2s")).not.toBe(draftKey("c12", "s"));
  });
});

describe("the debounce", () => {
  test("a keystroke arms a write DRAFT_DEBOUNCE_MS later, and the deadline is reported", () => {
    const c = clock();
    const s = createDraftScheduler(c.now);
    s.touch(["c1", "s1"], { text: "h", photos: [] });
    expect(s.dueIn(c.now())).toBe(DRAFT_DEBOUNCE_MS);
    c.advance(DRAFT_DEBOUNCE_MS - 1);
    expect(s.dueIn(c.now())).toBe(1);
    c.advance(1);
    expect(s.dueIn(c.now())).toBe(0);
  });

  test("typing re-arms it: only the LAST content is written (one write, not one per key)", () => {
    const c = clock();
    const s = createDraftScheduler(c.now);
    s.touch(["c1", "s1"], { text: "he", photos: [] });
    c.advance(100);
    s.touch(["c1", "s1"], { text: "hel", photos: [] });
    c.advance(100);
    s.touch(["c1", "s1"], { text: "hello", photos: [] });
    const due = s.take();
    expect(due).toHaveLength(1);
    expect(due[0]?.content.text).toBe("hello");
    expect(s.dueIn(c.now())).toBeNull(); // nothing pending any more
  });

  test("force writes now: an item created from the field leaves the text on disk first", () => {
    const c = clock();
    const s = createDraftScheduler(c.now);
    s.force(["c1", "s1"], { text: "hi", photos: [] });
    expect(s.dueIn(c.now())).toBe(0);
    expect(pendingKeys(s, c.now())).toEqual([draftKey("c1", "s1")]);
  });

  test("two sessions are two pending writes, each with its own content", () => {
    const c = clock();
    const s = createDraftScheduler(c.now);
    s.touch(["c1", "a"], { text: "A", photos: [] });
    c.advance(10);
    s.touch(["c1", "b"], { text: "B", photos: [] });
    expect(s.take().map((entry) => entry.content.text)).toEqual(["A", "B"]);
  });

  test("clear forgets everything pending (the app is gone; nothing is written)", () => {
    const c = clock();
    const s = createDraftScheduler(c.now);
    s.touch(["c1", "s1"], { text: "x", photos: [] });
    s.clear();
    expect(s.take()).toEqual([]);
    expect(s.dueIn(c.now())).toBeNull();
  });
});

describe("what is stored", () => {
  test("an empty draft is nothing to store (null), so the store deletes it", () => {
    expect(draftOf(["c1", "s1"], { text: "", photos: [] }, 5)).toBeNull();
    expect(isEmptyDraft({ text: "", photos: [] })).toBe(true);
  });

  test("photo chips alone are a draft: the person's chips are work", () => {
    const draft = draftOf(["c1", "s1"], { text: "", photos: ["/a/0.png"] }, 7);
    expect(draft?.photos).toEqual(["/a/0.png"]);
    expect(draft?.text).toBe("");
    expect(isEmptyDraft({ text: "", photos: ["/a/0.png"] })).toBe(false);
  });

  test("the stored draft round-trips its content, with the save stamp", () => {
    const draft = draftOf(["c1", "s1"], { text: "hi", photos: ["/a/0.png"] }, 42);
    expect(draft).toEqual({
      computerId: "c1",
      sessionId: "s1",
      text: "hi",
      photos: ["/a/0.png"],
      savedAt: 42,
    });
    expect(draft === null ? null : contentOf(draft)).toEqual({ text: "hi", photos: ["/a/0.png"] });
  });

  test("the stored photos are a copy (a caller's later push never mutates it)", () => {
    const photos = ["/a/0.png"];
    const draft = draftOf(["c1", "s1"], { text: "t", photos }, 1);
    photos.push("/a/1.png");
    expect(draft?.photos).toEqual(["/a/0.png"]);
  });
});
