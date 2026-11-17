/**
 * `artifact-seen-store.ts` (docs/feat/model-artifacts.md D9, T7): round-trip; a
 * missing / garbage / unknown-`v` record reads as NOTHING SEEN and leaves the
 * bytes untouched; a read error refuses writes; the `opened` list is bounded and
 * its drops are oldest-first; and the per-computer key, so two computers' ids
 * cannot hide each other's artifacts.
 */
import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_SEEN_KEY,
  ARTIFACT_SEEN_VERSION,
  ArtifactSeenPreserved,
  MAX_OPENED,
  createArtifactSeenStore,
  markArtifactOpened,
  markGalleryOpened,
  seenFor,
  sessionKey,
} from "../src/artifact-seen-store.ts";
import type { SecureKV, SecureSetOptions } from "../src/computer-store.ts";

const ACCESSIBLE = 6;
const SHA = (n: number): string => `${n}`.padStart(4, "0").padEnd(64, "a");

/** An in-memory Keychain that records every write, so "untouched" is provable. */
function fakeKV(initial: string | null = null) {
  const items = new Map<string, string>();
  if (initial !== null) {
    items.set(ARTIFACT_SEEN_KEY, initial);
  }
  const writes: { key: string; value: string; options: SecureSetOptions }[] = [];
  const kv: SecureKV = {
    get: async (key) => items.get(key) ?? null,
    set: async (key, value, options) => {
      writes.push({ key, value, options });
      items.set(key, value);
    },
    delete: async (key) => {
      items.delete(key);
    },
  };
  return { kv, items, writes };
}

function store(initial: string | null = null) {
  const fake = fakeKV(initial);
  return {
    ...fake,
    store: createArtifactSeenStore({ kv: fake.kv, keychainAccessible: ACCESSIBLE }),
  };
}

const record = (seen: unknown, v: unknown = ARTIFACT_SEEN_VERSION): string =>
  JSON.stringify({ v, seen });

describe("round-trip", () => {
  test("a written map reads back exactly, under the versioned shape and the Keychain class", async () => {
    const s = store();
    const map = { "mbp/s1": { lastGalleryAt: 1_000, opened: [SHA(1), SHA(2)] } };
    await s.store.write(map);
    expect((await s.store.read()).seen).toEqual(map);
    expect(JSON.parse(s.writes[0]?.value ?? "{}")).toEqual({
      v: ARTIFACT_SEEN_VERSION,
      seen: map,
    });
    expect(s.writes[0]?.options.keychainAccessible).toBe(ACCESSIBLE);
    expect(s.writes[0]?.key).toBe(ARTIFACT_SEEN_KEY);
  });

  test("a missing record is empty and writable", async () => {
    const read = await store().store.read();
    expect(read).toEqual({ seen: {}, writable: true });
  });
});

describe("an unreadable record is never written over", () => {
  for (const [label, raw] of [
    ["an unknown version", record({}, 2)],
    ["garbage", "{not json"],
    ["a bare array", "[]"],
    ["no `seen`", JSON.stringify({ v: ARTIFACT_SEEN_VERSION })],
  ] as const) {
    test(`${label}: reads as nothing seen, writable false, and a write is REFUSED`, async () => {
      const s = store(raw);
      const read = await s.store.read();
      expect(read.seen).toEqual({});
      expect(read.writable).toBe(false);
      expect(s.store.write({ "mbp/s1": { lastGalleryAt: 5, opened: [] } })).rejects.toBeInstanceOf(
        ArtifactSeenPreserved,
      );
      expect(s.items.get(ARTIFACT_SEEN_KEY)).toBe(raw);
      expect(s.writes).toEqual([]);
    });
  }

  test("a malformed ENTRY inside a valid record is dropped, and the record stays writable", async () => {
    // The tolerated direction: a dropped entry can only make an artifact look NEW
    // (never hide one), and refusing the whole record would burn it forever.
    const s = store(
      record({ "mbp/bad": { opened: [] }, "mbp/s1": { lastGalleryAt: 9, opened: [SHA(1)] } }),
    );
    const read = await s.store.read();
    expect(read.writable).toBe(true);
    expect(Object.keys(read.seen)).toEqual(["mbp/s1"]);
    await s.store.write(read.seen);
    expect(s.writes.length).toBe(1);
  });

  test("a bad sha inside an entry is filtered out; its clock is kept", async () => {
    const read = await store(
      record({ "mbp/s1": { lastGalleryAt: 4, opened: ["x", SHA(1)] } }),
    ).store.read();
    expect(read.seen["mbp/s1"]).toEqual({ lastGalleryAt: 4, opened: [SHA(1)] });
  });

  test("a record that cannot be READ also refuses writes (a read error is not a write)", async () => {
    const writes: string[] = [];
    const kv: SecureKV = {
      get: async () => {
        throw new Error("keychain busy");
      },
      set: async (_key, value) => {
        writes.push(value);
      },
      delete: async () => {},
    };
    const s = createArtifactSeenStore({ kv, keychainAccessible: ACCESSIBLE });
    expect(await s.read()).toEqual({ seen: {}, writable: false });
    expect(s.write({})).rejects.toBeInstanceOf(ArtifactSeenPreserved);
    expect(writes).toEqual([]);
  });
});

describe("marking", () => {
  test("the gallery open moves the clock forward, never back", () => {
    const seen = markGalleryOpened({ lastGalleryAt: 0, opened: [] }, 1_000);
    expect(seen.lastGalleryAt).toBe(1_000);
    expect(markGalleryOpened(seen, 500).lastGalleryAt).toBe(1_000);
  });

  test("an artifact open appends its sha once (a re-open does not duplicate it)", () => {
    const once = markArtifactOpened({ lastGalleryAt: 0, opened: [] }, SHA(1));
    const twice = markArtifactOpened(once, SHA(1));
    expect(twice.opened).toEqual([SHA(1)]);
    expect(twice.opened).not.toBe(once.opened);
  });

  test("`opened` is bounded: the list keeps the newest MAX_OPENED and drops the oldest", () => {
    let seen = { lastGalleryAt: 0, opened: [] as readonly string[] };
    for (let i = 0; i < MAX_OPENED + 5; i += 1) {
      seen = markArtifactOpened(seen, SHA(i));
    }
    expect(seen.opened.length).toBe(MAX_OPENED);
    expect(seen.opened[0]).toBe(SHA(5));
    expect(seen.opened.at(-1)).toBe(SHA(MAX_OPENED + 4));
  });

  test("a stored list longer than the bound is trimmed on read (a newer build's leftover)", async () => {
    const long = Array.from({ length: MAX_OPENED + 3 }, (_v, i) => SHA(i));
    const read = await store(record({ "mbp/s1": { lastGalleryAt: 1, opened: long } })).store.read();
    expect(read.seen["mbp/s1"]?.opened.length).toBe(MAX_OPENED);
    expect(read.seen["mbp/s1"]?.opened.at(-1)).toBe(SHA(MAX_OPENED + 2));
  });
});

describe("seenFor", () => {
  test("an unknown session reads NOTHING_SEEN (everything counts as new)", () => {
    expect(seenFor({}, sessionKey("mbp", "s1"))).toEqual({ lastGalleryAt: 0, opened: [] });
    expect(seenFor({ "mbp/s1": { lastGalleryAt: 7, opened: [] } }, "mbp/s1").lastGalleryAt).toBe(7);
  });
});
