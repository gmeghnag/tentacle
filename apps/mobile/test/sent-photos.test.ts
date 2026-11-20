/**
 * fix/mobile-qa-1119 row 12: a photo this phone SENT keeps its pixels after a
 * resync rebuilds the rows from history (background → foreground, a `serve`
 * restart, a relaunch). History refs carry no file, and the protocol has no
 * read-back, so the outbox store indexes `ref id → copy` and the thumbnail
 * port answers from it.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef } from "@tentacle/core";
import { type OutboxFs, createOutboxStore, outboxPaths } from "../src/outbox-store.ts";
import { createItem } from "../src/outbox.ts";
import { sentPhotoSource, withSentPhotos } from "../src/sent-photos.ts";

const ROOT = "file:///support/outbox";
const PATHS = outboxPaths(ROOT, "c1");

function memoryFs(): OutboxFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, text) {
      files.set(path, text);
    },
    async rename(from, to) {
      const text = files.get(from);
      if (text === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      files.set(to, text);
      files.delete(from);
    },
    async remove(path) {
      files.delete(path);
    },
  } as OutboxFs & { readonly files: Map<string, string> };
}

const ref = (id: string): AttachmentRef => ({ id, mimeType: "image/png", size: 3 });

function photoItem(id: string, file: string) {
  let n = 0;
  return createItem(
    {
      computerId: "c1",
      sessionId: "s1",
      kind: "prompt",
      text: "PHOTO",
      photos: [{ file, mimeType: "image/png", name: "a.png", ref: ref(id) }],
      basis: { historyLength: 0, runningTurnId: null },
    },
    () => {
      n += 1;
      return `k${n}`;
    },
  );
}

const signal = new AbortController().signal;

describe("the sent-photo index (row 12)", () => {
  test("a photo an item holds a ref for is indexed, and the index outlives the item AND a relaunch", async () => {
    // Mutation: drop the `withSentPhotos` call in `setItems` → red.
    const fs = memoryFs();
    const store = createOutboxStore(fs, PATHS, () => 1);
    await store.load();
    const item = photoItem("a".repeat(64), `${ROOT}/photos/1-1-a.png`);
    await store.setItems([item]);
    await store.removeItem(item.itemId);
    const relaunched = createOutboxStore(fs, PATHS, () => 1);
    await relaunched.load();
    expect(relaunched.data.sentPhotos?.["a".repeat(64)]).toBe(`${ROOT}/photos/1-1-a.png`);
  });

  test("the thumbnail port answers a history ref with its copy, and null for any other", async () => {
    const source = sentPhotoSource((id) => (id === "x" ? "file:///copy.png" : undefined));
    expect(await source.fetch({ id: "x", mimeType: "image/png", size: 3 }, signal)).toEqual({
      id: "x",
      uri: "file:///copy.png",
    });
    expect(await source.fetch({ id: "y", mimeType: "image/png", size: 3 }, signal)).toBeNull();
  });

  test("bounded to the newest entries; a re-sent id moves to the end", () => {
    let index = withSentPhotos(undefined, [
      { id: "a", uri: "1" },
      { id: "b", uri: "2" },
    ]);
    index = withSentPhotos(index, [{ id: "a", uri: "3" }], 2);
    index = withSentPhotos(index, [{ id: "c", uri: "4" }], 2);
    expect(index).toEqual({ a: "3", c: "4" });
  });

  test("nothing new → the SAME index (no rewrite churn)", () => {
    const index = { a: "1" };
    expect(withSentPhotos(index, [{ id: "a", uri: "1" }])).toBe(index);
    expect(withSentPhotos(index, [])).toBe(index);
  });

  test("a malformed index is dropped, never a reason to set the outbox aside", async () => {
    const fs = memoryFs();
    fs.files.set(
      PATHS.state,
      JSON.stringify({ schemaVersion: 1, items: [], drafts: [], ownIds: [], sentPhotos: { a: 7 } }),
    );
    const store = createOutboxStore(fs, PATHS, () => 1);
    expect((await store.load()).kind).toBe("loaded");
    expect(store.data.sentPhotos).toBeUndefined();
  });
});
