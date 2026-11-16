/**
 * The phone's photo copies outlive their outbox item (fix round 2, Review round
 * 2's R2-1): the transcript's own row draws the file after the daemon has
 * acknowledged the send, so the ack must not delete it — and the folder is bound
 * here instead.
 */
import { describe, expect, test } from "bun:test";
import type { OutboxFs } from "../src/outbox-store.ts";
import {
  COPY_GRACE_MS,
  KEEP_DISPLAY_COPIES,
  copiesToRemove,
  inUseCopies,
  prunePhotoCopies,
} from "../src/photo-copies.ts";

const DAY = 24 * 60 * 60 * 1000;
/** A pick stamp, `days` before `NOW`. */
const NOW = 1_700_000_000_000;
const pick = (days: number, seq = 1): string =>
  `file:///o/photos/${NOW - Math.round(days * DAY)}-${seq}-IMG_4876.jpg`;

/** An fs over one folder, for `prunePhotoCopies`. */
function folder(files: readonly string[]): OutboxFs & { readonly left: () => readonly string[] } {
  const kept = new Set(files);
  return {
    left: () => [...kept],
    read: async () => null,
    write: async () => {},
    rename: async () => {},
    remove: async (path) => {
      kept.delete(path);
    },
    list: async () => [...kept],
  };
}

describe("what the folder keeps", () => {
  test("a copy still named by an item or a draft is kept however old (mutation: drop the `inUse` check → red)", () => {
    const held = pick(30);
    const remove = copiesToRemove([held, pick(40, 2), pick(41, 3)], {
      now: NOW,
      inUse: [held],
      keep: 0,
    });
    // The one in use is never a candidate; the others are (both past grace+tail).
    expect(remove).not.toContain(held);
    expect(remove).toContain(pick(40, 2));
    expect(remove).toContain(pick(41, 3));
  });

  test("the newest copies stay even when old, so the row on screen keeps its pixels (mutation: no `keep` window → red)", () => {
    // Sixty old copies, no items at all: the newest are the ones a transcript
    // could still be showing.
    const listing = Array.from({ length: KEEP_DISPLAY_COPIES + 2 }, (_, at) => pick(30, at + 1));
    const remove = copiesToRemove(listing, { now: NOW });
    expect(remove).toHaveLength(2);
    // The two it drops are the OLDEST of the tail (the smallest stamps).
    expect(remove).toEqual([pick(30, 2), pick(30, 1)]);
  });

  test("a copy inside the grace window is kept whatever the tail (mutation: no grace → red)", () => {
    const fresh = pick(0, 99);
    const listing = [
      ...Array.from({ length: KEEP_DISPLAY_COPIES }, (_, at) => pick(30, at + 1)),
      fresh,
    ];
    expect(copiesToRemove(listing, { now: NOW })).toEqual([]);
    // One day past the grace, the same copy is eligible (`keep: 0` isolates the
    // grace rule from the tail).
    const old = pick(COPY_GRACE_MS / DAY + 1, 99);
    expect(copiesToRemove([old], { now: NOW, keep: 0 })).toEqual([old]);
  });

  test("a file that is not one of ours is never removed (mutation: drop the name check → red)", () => {
    const listing = [pick(40), "/o/photos/notes.txt", "/o/photos/.DS_Store", "file:///o/photos/x"];
    expect(copiesToRemove(listing, { now: NOW, keep: 0 })).toEqual([pick(40)]);
    // With the default window it is the newest copy, so nothing goes at all.
    expect(copiesToRemove(listing, { now: NOW })).toEqual([]);
  });

  test("pruning removes exactly those paths, and a broken folder is not an error", async () => {
    const old = pick(40);
    const fresh = pick(0);
    const fs = folder([old, fresh, "/o/photos/keep.txt"]);
    const removed = await prunePhotoCopies(fs, "file:///o/photos", { now: NOW, keep: 0 });
    expect(removed).toEqual([old]);
    expect(fs.left()).toEqual([fresh, "/o/photos/keep.txt"]);

    // A folder that cannot be listed: nothing happens, nothing throws.
    const broken: OutboxFs = { ...fs, list: async () => Promise.reject(new Error("EIO")) };
    expect(await prunePhotoCopies(broken, "file:///o/photos", { now: NOW, keep: 0 })).toEqual([]);
  });

  test("what a store still names is in use: its items' photos AND its drafts' chips (mutation: items only → a draft's photo is deleted under the field)", () => {
    const data = {
      items: [
        {
          itemId: "i1",
          computerId: "c",
          sessionId: "s",
          kind: "prompt" as const,
          text: "hi",
          photos: [{ file: pick(50, 1), mimeType: "image/jpeg", name: "a.jpg" }],
          turnId: "t",
          enqueueId: "e",
          steerTurnId: null,
          basis: { historyLength: 0, runningTurnId: null },
          state: "waiting" as const,
        },
      ],
      drafts: [{ computerId: "c", sessionId: "s2", text: "d", photos: [pick(50, 2)], savedAt: 1 }],
      ownIds: [],
    };
    expect(inUseCopies(data)).toEqual([pick(50, 1), pick(50, 2)]);
    // And neither is ever a candidate, however old.
    expect(
      copiesToRemove([pick(50, 1), pick(50, 2)], { now: NOW, inUse: inUseCopies(data) }),
    ).toEqual([]);
  });
});
