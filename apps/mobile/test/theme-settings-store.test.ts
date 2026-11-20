/**
 * `theme-settings-store.ts` (docs/feat/mobile-theme-beta.md): the Lato try-out
 * switch, remembered per device — the gallery setting's shape and the same
 * fail-safe rules (a broken store never turns the try-out ON), proven the same way.
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV } from "../src/computer-store.ts";
import {
  DEFAULT_THEME_SETTINGS,
  THEME_SETTINGS_KEY,
  ThemeSettingsPreserved,
  createThemeSettingsHolder,
  createThemeSettingsStore,
} from "../src/theme-settings-store.ts";

function fake(initial: string | null = null, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(THEME_SETTINGS_KEY, initial);
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
    store: createThemeSettingsStore({ kv, keychainAccessible: 6 }),
    items,
    writes: () => writes,
    reads: () => reads,
  };
}

describe("round-trip", () => {
  test("the default is OFF", () => {
    expect(DEFAULT_THEME_SETTINGS).toEqual({ lato: false });
  });

  test("a pick reads back, as a v1 record under its own key", async () => {
    const f = fake();
    await f.store.write({ lato: true });
    expect(await f.store.read()).toEqual({ settings: { lato: true }, writable: true });
    expect(JSON.parse(f.items.get(THEME_SETTINGS_KEY) ?? "")).toEqual({ v: 1, lato: true });
    expect(THEME_SETTINGS_KEY).toBe("tentacle.theme");
  });
});

describe("fail-safe reads", () => {
  for (const [name, raw] of [
    ["bytes that are not JSON", "{not json"],
    ["JSON that is not an object", "42"],
    ["an object that is not our record", '{"lato":true}'],
    ["a value that is not a boolean", '{"v":1,"lato":"yes"}'],
    ["a newer build's version", '{"v":2,"lato":true}'],
  ] as const) {
    test(`${name} → OFF, and never written over`, async () => {
      const f = fake(raw);
      const read = await f.store.read();
      expect(read).toEqual({ settings: { lato: false }, writable: false });
      await expect(f.store.write({ lato: true })).rejects.toBeInstanceOf(ThemeSettingsPreserved);
      expect(f.items.get(THEME_SETTINGS_KEY)).toBe(raw);
      expect(f.writes()).toBe(0);
    });
  }

  test("a keychain read error reads OFF and refuses later writes", async () => {
    const f = fake(null, { failGet: true });
    expect(await f.store.read()).toEqual({ settings: { lato: false }, writable: false });
    await expect(f.store.write({ lato: true })).rejects.toBeInstanceOf(ThemeSettingsPreserved);
  });

  test("a write error rejects", async () => {
    const f = fake(null, { failSet: true });
    await expect(f.store.write({ lato: true })).rejects.toThrow("disk full");
  });
});

describe("the holder", () => {
  test("load publishes what is on disk, once per run", async () => {
    const f = fake('{"v":1,"lato":true}');
    const holder = createThemeSettingsHolder(f.store);
    const seen: string[] = [];
    holder.subscribe((s) => seen.push(String(s.lato)));
    await holder.load();
    await holder.load();
    expect(holder.current()).toEqual({ lato: true });
    expect(seen).toEqual(["true"]);
    expect(f.reads()).toBe(1);
  });

  test("a pick is published and saved; an unsubscribed listener hears nothing", async () => {
    const f = fake();
    const holder = createThemeSettingsHolder(f.store);
    await holder.load();
    const seen: string[] = [];
    const off = holder.subscribe((s) => seen.push(String(s.lato)));
    await holder.set({ lato: true });
    off();
    await holder.set({ lato: false });
    expect(seen).toEqual(["true"]);
    expect(JSON.parse(f.items.get(THEME_SETTINGS_KEY) ?? "")).toEqual({ v: 1, lato: false });
  });

  test("a pick made while the read is in flight is not undone by the read", async () => {
    const f = fake('{"v":1,"lato":false}');
    const holder = createThemeSettingsHolder(f.store);
    const loading = holder.load();
    await holder.set({ lato: true });
    await loading;
    expect(holder.current()).toEqual({ lato: true });
  });

  test("a failed write still switches the theme for this run", async () => {
    const f = fake(null, { failSet: true });
    const holder = createThemeSettingsHolder(f.store);
    await holder.load();
    await expect(holder.set({ lato: true })).rejects.toThrow("disk full");
    expect(holder.current()).toEqual({ lato: true });
  });

  test("over an unreadable record: the theme switches, the record is left untouched", async () => {
    const f = fake('{"v":9,"lato":true}');
    const holder = createThemeSettingsHolder(f.store);
    await holder.load();
    await expect(holder.set({ lato: true })).rejects.toBeInstanceOf(ThemeSettingsPreserved);
    expect(holder.current()).toEqual({ lato: true });
    expect(f.items.get(THEME_SETTINGS_KEY)).toBe('{"v":9,"lato":true}');
  });
});
