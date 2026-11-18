/**
 * `chart-settings-store.ts` — the Charts setting (docs/feat/mobile-chart-labels.md
 * D7): the activity store's shape and the same fail-safe rules, proven the same
 * way.
 */
import { describe, expect, test } from "bun:test";
import {
  CHART_SETTINGS_KEY,
  ChartSettingsPreserved,
  DEFAULT_CHART_SETTINGS,
  createChartSettingsHolder,
  createChartSettingsStore,
} from "../src/chart-settings-store.ts";
import type { SecureKV } from "../src/computer-store.ts";

function fake(initial: string | null = null, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(CHART_SETTINGS_KEY, initial);
  let writes = 0;
  const kv: SecureKV = {
    get: async (key) => {
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
    store: createChartSettingsStore({ kv, keychainAccessible: 6 }),
    items,
    writes: () => writes,
  };
}

describe("round-trip", () => {
  test("the default is labels on the lines (C)", () => {
    expect(DEFAULT_CHART_SETTINGS).toEqual({ labels: "inside" });
  });

  test("a mode reads back, as a v1 record", async () => {
    const f = fake();
    await f.store.write({ labels: "legend" });
    expect(await f.store.read()).toEqual({ settings: { labels: "legend" }, writable: true });
    expect(JSON.parse(f.items.get(CHART_SETTINGS_KEY) ?? "")).toEqual({ v: 1, labels: "legend" });
  });
});

describe("fail-safe reads", () => {
  for (const [name, raw] of [
    ["bytes that are not JSON", "{not json"],
    ["JSON that is not an object", "42"],
    ["an object that is not our record", '{"labels":"legend"}'],
    ["a mode this build does not know", '{"v":1,"labels":"above"}'],
  ] as const) {
    test(`${name} → the default, and never written over`, async () => {
      const f = fake(raw);
      const read = await f.store.read();
      expect(read.settings).toEqual({ labels: "inside" });
      expect(read.writable).toBe(false);
      await expect(f.store.write({ labels: "legend" })).rejects.toBeInstanceOf(
        ChartSettingsPreserved,
      );
      expect(f.items.get(CHART_SETTINGS_KEY)).toBe(raw);
      expect(f.writes()).toBe(0);
    });
  }

  test("a newer build's version → the default, left untouched", async () => {
    const f = fake('{"v":2,"labels":"legend"}');
    expect(await f.store.read()).toEqual({ settings: { labels: "inside" }, writable: false });
    await expect(f.store.write({ labels: "inside" })).rejects.toBeInstanceOf(
      ChartSettingsPreserved,
    );
    expect(f.items.get(CHART_SETTINGS_KEY)).toBe('{"v":2,"labels":"legend"}');
  });

  test("a keychain read error reads the default and refuses later writes", async () => {
    const f = fake(null, { failGet: true });
    expect(await f.store.read()).toEqual({ settings: { labels: "inside" }, writable: false });
    await expect(f.store.write({ labels: "legend" })).rejects.toBeInstanceOf(
      ChartSettingsPreserved,
    );
  });

  test("a write error rejects (Settings says it did not save)", async () => {
    const f = fake(null, { failSet: true });
    await expect(f.store.write({ labels: "legend" })).rejects.toThrow("disk full");
  });
});

describe("the holder", () => {
  test("subscribe fires on a set, and load publishes what is on disk", async () => {
    const f = fake('{"v":1,"labels":"legend"}');
    const holder = createChartSettingsHolder(f.store);
    const seen: string[] = [];
    const off = holder.subscribe((s) => seen.push(s.labels));
    await holder.load();
    expect(holder.current()).toEqual({ labels: "legend" });
    await holder.set({ labels: "inside" });
    expect(seen).toEqual(["legend", "inside"]);
    off();
    await holder.set({ labels: "legend" });
    expect(seen).toEqual(["legend", "inside"]);
  });

  test("a failed write still publishes the pick for this run (memory keeps it)", async () => {
    const f = fake(null, { failSet: true });
    const holder = createChartSettingsHolder(f.store);
    await holder.load();
    await expect(holder.set({ labels: "legend" })).rejects.toThrow("disk full");
    expect(holder.current()).toEqual({ labels: "legend" });
  });

  test("over an unreadable record the pick is refused and nothing changes", async () => {
    const f = fake('{"v":9,"labels":"legend"}');
    const holder = createChartSettingsHolder(f.store);
    await holder.load();
    expect(holder.writable()).toBe(false);
    await expect(holder.set({ labels: "inside" })).rejects.toBeInstanceOf(ChartSettingsPreserved);
    expect(holder.current()).toEqual({ labels: "inside" });
    expect(f.items.get(CHART_SETTINGS_KEY)).toBe('{"v":9,"labels":"legend"}');
  });
});
