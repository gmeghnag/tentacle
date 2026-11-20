/**
 * `gallery-settings-store.ts` (docs/feat/mobile-gallery-polish.md): the gallery's
 * list ↔ grid pick, remembered per device — the Charts setting's shape and the
 * same fail-safe rules, proven the same way.
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV } from "../src/computer-store.ts";
import {
  DEFAULT_GALLERY_SETTINGS,
  GALLERY_SETTINGS_KEY,
  GallerySettingsPreserved,
  createGallerySettingsHolder,
  createGallerySettingsStore,
} from "../src/gallery-settings-store.ts";

function fake(initial: string | null = null, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(GALLERY_SETTINGS_KEY, initial);
  let writes = 0;
  let reads = 0;
  const kv: SecureKV = {
    get: async (key) => {
      reads += 1;
      if (opts.failGet === true) throw new Error("keychain locked");
      return items.get(key) ?? null;
    },
    set: async (key, value) => {
      if (opts.failSet === true) throw new Error("disk full");
      writes += 1;
      items.set(key, value);
    },
    delete: async (key) => {
      items.delete(key);
    },
  };
  return {
    store: createGallerySettingsStore({ kv, keychainAccessible: 6 }),
    items,
    writes: () => writes,
    reads: () => reads,
  };
}

describe("round-trip", () => {
  test("the default is the list", () => {
    expect(DEFAULT_GALLERY_SETTINGS).toEqual({ layout: "list" });
  });

  test("a pick reads back, as a v1 record under its own key", async () => {
    const f = fake();
    await f.store.write({ layout: "grid" });
    expect(await f.store.read()).toEqual({ settings: { layout: "grid" }, writable: true });
    expect(JSON.parse(f.items.get(GALLERY_SETTINGS_KEY) ?? "")).toEqual({ v: 1, layout: "grid" });
    expect(GALLERY_SETTINGS_KEY).toBe("tentacle.gallery");
  });
});

describe("fail-safe reads", () => {
  for (const [name, raw] of [
    ["bytes that are not JSON", "{not json"],
    ["JSON that is not an object", "42"],
    ["an object that is not our record", '{"layout":"grid"}'],
    ["a look this build does not know", '{"v":1,"layout":"carousel"}'],
    ["a newer build's version", '{"v":2,"layout":"grid"}'],
  ] as const) {
    test(`${name} → the list, and never written over`, async () => {
      const f = fake(raw);
      const read = await f.store.read();
      expect(read).toEqual({ settings: { layout: "list" }, writable: false });
      await expect(f.store.write({ layout: "grid" })).rejects.toBeInstanceOf(
        GallerySettingsPreserved,
      );
      expect(f.items.get(GALLERY_SETTINGS_KEY)).toBe(raw);
      expect(f.writes()).toBe(0);
    });
  }

  test("a keychain read error reads the list and refuses later writes", async () => {
    const f = fake(null, { failGet: true });
    expect(await f.store.read()).toEqual({ settings: { layout: "list" }, writable: false });
    await expect(f.store.write({ layout: "grid" })).rejects.toBeInstanceOf(
      GallerySettingsPreserved,
    );
  });

  test("a write error rejects", async () => {
    const f = fake(null, { failSet: true });
    await expect(f.store.write({ layout: "grid" })).rejects.toThrow("disk full");
  });
});

describe("the holder", () => {
  test("load publishes what is on disk, once per run", async () => {
    const f = fake('{"v":1,"layout":"grid"}');
    const holder = createGallerySettingsHolder(f.store);
    const seen: string[] = [];
    holder.subscribe((s) => seen.push(s.layout));
    await holder.load();
    await holder.load();
    expect(holder.current()).toEqual({ layout: "grid" });
    expect(seen).toEqual(["grid"]);
    expect(f.reads()).toBe(1);
  });

  test("a pick is published and saved; an unsubscribed listener hears nothing", async () => {
    const f = fake();
    const holder = createGallerySettingsHolder(f.store);
    await holder.load();
    const seen: string[] = [];
    const off = holder.subscribe((s) => seen.push(s.layout));
    await holder.set({ layout: "grid" });
    off();
    await holder.set({ layout: "list" });
    expect(seen).toEqual(["grid"]);
    expect(JSON.parse(f.items.get(GALLERY_SETTINGS_KEY) ?? "")).toEqual({ v: 1, layout: "list" });
  });

  test("a pick made while the read is in flight is not undone by the read", async () => {
    const f = fake('{"v":1,"layout":"list"}');
    const holder = createGallerySettingsHolder(f.store);
    const loading = holder.load();
    await holder.set({ layout: "grid" });
    await loading;
    expect(holder.current()).toEqual({ layout: "grid" });
  });

  test("a failed write still switches the look for this run", async () => {
    const f = fake(null, { failSet: true });
    const holder = createGallerySettingsHolder(f.store);
    await holder.load();
    await expect(holder.set({ layout: "grid" })).rejects.toThrow("disk full");
    expect(holder.current()).toEqual({ layout: "grid" });
  });

  test("over an unreadable record: the look switches, the record is left untouched", async () => {
    const f = fake('{"v":9,"layout":"grid"}');
    const holder = createGallerySettingsHolder(f.store);
    await holder.load();
    await expect(holder.set({ layout: "grid" })).rejects.toBeInstanceOf(GallerySettingsPreserved);
    expect(holder.current()).toEqual({ layout: "grid" });
    expect(f.items.get(GALLERY_SETTINGS_KEY)).toBe('{"v":9,"layout":"grid"}');
  });
});
