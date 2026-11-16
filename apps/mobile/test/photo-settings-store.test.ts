/**
 * The photo settings (fix/mobile-media-live item 5): the "Send photos at
 * original size" switch's record.
 *
 * Four fail-safe rules, each pinned here with the mutation it is red on:
 * absent/unreadable/unknown-version reads `sendOriginal: false` (the downscale
 * ON, so the switch is the way out and never a surprise); an unknown `v` is
 * never overwritten; a write failure rejects; and the holder keeps the pick in
 * memory only when the write landed.
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV } from "../src/computer-store.ts";
import {
  DEFAULT_PHOTO_SETTINGS,
  PHOTO_SETTINGS_KEY,
  PHOTO_SETTINGS_VERSION,
  PhotoSettingsPreserved,
  createPhotoSettingsHolder,
  createPhotoSettingsStore,
} from "../src/photo-settings-store.ts";

function memoryKv(initial: Record<string, string> = {}): SecureKV & {
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

const store = (kv: SecureKV) => createPhotoSettingsStore({ kv, keychainAccessible: 1 });

describe("the photo settings record", () => {
  test("absent → the defaults, downscale ON (mutation: default `sendOriginal: true` → every photo full size)", async () => {
    const read = await store(memoryKv()).read();
    expect(read.settings).toEqual({ sendOriginal: false });
    expect(read.writable).toBe(true);
  });

  test("a v1 record is read as written", async () => {
    const kv = memoryKv({
      [PHOTO_SETTINGS_KEY]: JSON.stringify({ v: PHOTO_SETTINGS_VERSION, sendOriginal: true }),
    });
    expect(await store(kv).read()).toEqual({ settings: { sendOriginal: true }, writable: true });
  });

  test("an UNKNOWN version is read as the default and never written over (mutation: write anyway → a newer build's choice destroyed)", async () => {
    const raw = JSON.stringify({ v: PHOTO_SETTINGS_VERSION + 1, sendOriginal: true });
    const kv = memoryKv({ [PHOTO_SETTINGS_KEY]: raw });
    const settings = createPhotoSettingsHolder(store(kv));
    await settings.load();
    expect(settings.current()).toEqual(DEFAULT_PHOTO_SETTINGS);
    expect(settings.writable()).toBe(false);
    await expect(settings.set({ sendOriginal: false })).rejects.toBeInstanceOf(
      PhotoSettingsPreserved,
    );
    expect(kv.data.get(PHOTO_SETTINGS_KEY)).toBe(raw);
  });

  test("bytes that are not the record are left untouched too", async () => {
    const kv = memoryKv({ [PHOTO_SETTINGS_KEY]: "not json" });
    await expect(store(kv).read()).resolves.toEqual({
      settings: DEFAULT_PHOTO_SETTINGS,
      writable: false,
    });
  });

  test("a `sendOriginal` that is not a boolean is not trusted", async () => {
    const kv = memoryKv({
      [PHOTO_SETTINGS_KEY]: JSON.stringify({ v: PHOTO_SETTINGS_VERSION, sendOriginal: "yes" }),
    });
    await expect(store(kv).read()).resolves.toEqual({
      settings: DEFAULT_PHOTO_SETTINGS,
      writable: false,
    });
  });

  test("a Keychain READ error resolves the defaults, unwritable (never throws at launch)", async () => {
    const kv: SecureKV = {
      get: () => Promise.reject(new Error("keychain locked")),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    await expect(store(kv).read()).resolves.toEqual({
      settings: DEFAULT_PHOTO_SETTINGS,
      writable: false,
    });
  });

  test("a WRITE error rejects, and the holder keeps the old value (mutation: adopt the pick regardless → Settings shows a switch that is not in force)", async () => {
    const kv: SecureKV = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error("keychain full")),
      delete: () => Promise.resolve(),
    };
    const settings = createPhotoSettingsHolder(store(kv));
    await settings.load();
    await expect(settings.set({ sendOriginal: true })).rejects.toThrow("keychain full");
    expect(settings.current()).toEqual(DEFAULT_PHOTO_SETTINGS);
  });

  test("a write lands the record AND the in-memory copy (the next pick reads it)", async () => {
    const kv = memoryKv();
    const settings = createPhotoSettingsHolder(store(kv));
    await settings.load();
    await settings.set({ sendOriginal: true });
    expect(settings.current()).toEqual({ sendOriginal: true });
    expect(JSON.parse(kv.data.get(PHOTO_SETTINGS_KEY) ?? "{}")).toEqual({
      v: PHOTO_SETTINGS_VERSION,
      sendOriginal: true,
    });
  });
});
