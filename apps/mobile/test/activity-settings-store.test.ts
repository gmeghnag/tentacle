/**
 * `activity-settings-store.ts` — the Activity button setting (docs/feat/mobile-chrome.md
 * Design 6, F22): round-trip and the three fail-safe rules, the
 * `voice-settings-store.test.ts` shape.
 */
import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_SETTINGS_KEY,
  ActivitySettingsPreserved,
  DEFAULT_ACTIVITY_SETTINGS,
  createActivitySettingsHolder,
  createActivitySettingsStore,
  listEndOn,
} from "../src/activity-settings-store.ts";
import type { SecureKV } from "../src/computer-store.ts";

function fake(initial: string | null = null, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const items = new Map<string, string>();
  if (initial !== null) {
    items.set(ACTIVITY_SETTINGS_KEY, initial);
  }
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
  const store = createActivitySettingsStore({ kv, keychainAccessible: 6 });
  return { store, items, writes: () => writes };
}

describe("round-trip", () => {
  test("mode + position read back, as a v1 record", async () => {
    const f = fake();
    const s = { mode: "floating" as const, position: { edge: "left" as const, yFraction: 0.25 } };
    await f.store.write(s);
    expect(await f.store.read()).toEqual({ settings: s, writable: true });
    expect(JSON.parse(f.items.get(ACTIVITY_SETTINGS_KEY) ?? "")).toEqual({ v: 1, ...s });
  });

  test("mode without a position reads back without one", async () => {
    const f = fake();
    await f.store.write({ mode: "floating" });
    expect(await f.store.read()).toEqual({ settings: { mode: "floating" }, writable: true });
  });

  test("the CENTRE is a resting place now: it round-trips (docs/feat/mobile-hub-center.md O2)", async () => {
    const f = fake();
    const s = { mode: "floating" as const, position: { edge: "center" as const, yFraction: 1 } };
    await f.store.write(s);
    expect(await f.store.read()).toEqual({ settings: s, writable: true });
    expect(JSON.parse(f.items.get(ACTIVITY_SETTINGS_KEY) ?? "")).toEqual({ v: 1, ...s });
  });
});

/**
 * Owner 6 of docs/feat/mobile-hub-center.md: `listEndAboveHub` is the second
 * ADDITIVE optional field in the same v1 record (the `opacity` precedent), and
 * `listEndOn` is the ONE place its default lives — absent means ON, today's
 * behaviour.
 */
describe("listEndAboveHub: an additive optional field, defaulting ON", () => {
  test("false and true round-trip, still inside v1", async () => {
    for (const listEndAboveHub of [false, true]) {
      const f = fake();
      const s = { mode: "floating" as const, listEndAboveHub };
      await f.store.write(s);
      expect(await f.store.read()).toEqual({ settings: s, writable: true });
      expect(JSON.parse(f.items.get(ACTIVITY_SETTINGS_KEY) ?? "")).toEqual({ v: 1, ...s });
    }
  });

  test("a bad value drops the FIELD only: the mode and position are kept, and it reads ON", async () => {
    for (const listEndAboveHub of ["no", 1, null, {} as unknown]) {
      const raw = JSON.stringify({
        v: 1,
        mode: "floating",
        position: { edge: "center", yFraction: 0.5 },
        listEndAboveHub,
      });
      const read = await fake(raw).store.read();
      expect(read).toEqual({
        settings: { mode: "floating", position: { edge: "center", yFraction: 0.5 } },
        writable: true,
      });
      expect(listEndOn(read.settings)).toBe(true);
    }
  });

  test("listEndOn: absent → true (today's behaviour), false → false, true → true", () => {
    expect(listEndOn({ mode: "floating" })).toBe(true);
    expect(listEndOn({ mode: "floating", listEndAboveHub: false })).toBe(false);
    expect(listEndOn({ mode: "floating", listEndAboveHub: true })).toBe(true);
  });
});

/**
 * docs/feat/mobile-hub-opacity.md Design 1: `opacity` is an ADDITIVE optional
 * field inside the same v1 record. Bumping `v` would make every older build
 * treat the record as unreadable and refuse to write it (rule 2), which is worse
 * than an old build dropping a field it does not know.
 */
describe("opacity: an additive optional field in the same v1 record", () => {
  test("round-trip: mode + position + opacity read back", async () => {
    const f = fake();
    const s = {
      mode: "floating" as const,
      position: { edge: "right" as const, yFraction: 0.5 },
      opacity: 60,
    };
    await f.store.write(s);
    expect(await f.store.read()).toEqual({ settings: s, writable: true });
    // Still v1: an older build keeps reading this record instead of preserving it.
    expect(JSON.parse(f.items.get(ACTIVITY_SETTINGS_KEY) ?? "")).toEqual({ v: 1, ...s });
  });

  test("an absent opacity reads back absent (→ the 100 % default)", async () => {
    const f = fake(JSON.stringify({ v: 1, mode: "floating" }));
    expect(await f.store.read()).toEqual({ settings: { mode: "floating" }, writable: true });
  });

  test("a bad opacity drops the opacity ONLY: the mode and position are kept", async () => {
    for (const opacity of ["50", null, Number.NaN, [55], {}]) {
      const raw = JSON.stringify({
        v: 1,
        mode: "floating",
        position: { edge: "left", yFraction: 0.25 },
        opacity,
      });
      expect(await fake(raw).store.read()).toEqual({
        settings: { mode: "floating", position: { edge: "left", yFraction: 0.25 } },
        writable: true,
      });
    }
  });

  test("an off-step or out-of-range opacity snaps to the nearest step (ties up)", async () => {
    // docs/feat/mobile-hub-defaults.md: the continuous 30–100 slider of
    // mobile-hub-opacity wrote any whole number; on read it lands on a step.
    for (const [opacity, expected] of [
      [35, 40],
      [30, 40],
      [62.6, 60],
      [70, 80],
      [10, 20],
      [150, 100],
    ] as const) {
      const raw = JSON.stringify({ v: 1, mode: "floating", opacity });
      expect(await fake(raw).store.read()).toEqual({
        settings: { mode: "floating", opacity: expected },
        writable: true,
      });
    }
  });

  test("a MODE write keeps the opacity (the holder spread, App.tsx:1626)", async () => {
    const f = fake();
    const h = createActivitySettingsHolder(f.store);
    await h.load();
    await h.set({ mode: "floating" });
    await h.set({ ...h.current(), opacity: 40 });
    expect(h.current()).toEqual({ mode: "floating", opacity: 40 });
    // The next mode change spreads `current()`, so the opacity survives it.
    await h.set({ ...h.current(), mode: "header" });
    expect(h.current()).toEqual({ mode: "header", opacity: 40 });
    expect(await f.store.read()).toEqual({
      settings: { mode: "header", opacity: 40 },
      writable: true,
    });
  });

  test("a POSITION write keeps the opacity (the holder spread, SessionScreen.tsx:1191)", async () => {
    const f = fake();
    const h = createActivitySettingsHolder(f.store);
    await h.load();
    await h.set({ mode: "floating", opacity: 35 });
    await h.set({ ...h.current(), position: { edge: "left", yFraction: 0.5 } });
    expect(h.current()).toEqual({
      mode: "floating",
      opacity: 35,
      position: { edge: "left", yFraction: 0.5 },
    });
  });

  test("a newer build's record still wins: a refused write keeps the bytes", async () => {
    const newer = JSON.stringify({ v: 9, mode: "orbit", opacity: 30 });
    const f = fake(newer);
    await f.store.read();
    await expect(f.store.write({ mode: "floating", opacity: 40 })).rejects.toBeInstanceOf(
      ActivitySettingsPreserved,
    );
    expect(f.items.get(ACTIVITY_SETTINGS_KEY)).toBe(newer);
  });

  test("an older build's record (no opacity) is not preserved — it is writable", async () => {
    const f = fake(
      JSON.stringify({ v: 1, mode: "floating", position: { edge: "left", yFraction: 0.1 } }),
    );
    const read = await f.store.read();
    expect(read.writable).toBe(true);
    await f.store.write({ ...read.settings, opacity: 70 });
    expect(JSON.parse(f.items.get(ACTIVITY_SETTINGS_KEY) ?? "").opacity).toBe(70);
  });
});

describe("rule 1: unreadable / missing / unknown v → the defaults (Floating at 80 %, no position)", () => {
  test("the default is the floating hub at 80 % (owner 2026-11-18; was Header)", () => {
    expect(DEFAULT_ACTIVITY_SETTINGS).toEqual({ mode: "floating", opacity: 80 });
  });
  test("a fresh install reads the floating hub at 80 %", async () => {
    expect((await fake().store.read()).settings).toEqual({ mode: "floating", opacity: 80 });
  });
  test("a STORED Header record keeps Header: only the absence of a choice gets the new default", async () => {
    expect(await fake(JSON.stringify({ v: 1, mode: "header" })).store.read()).toEqual({
      settings: { mode: "header" },
      writable: true,
    });
  });
  test("a stored Floating record WITHOUT an opacity keeps its solid look (100 %, not 80)", async () => {
    expect(await fake(JSON.stringify({ v: 1, mode: "floating" })).store.read()).toEqual({
      settings: { mode: "floating" },
      writable: true,
    });
  });
  test("switching mode on a fresh install keeps the 80 % (the holder spread writes it)", async () => {
    const f = fake();
    const h = createActivitySettingsHolder(f.store);
    await h.load();
    await h.set({ ...h.current(), mode: "header" });
    expect(JSON.parse(f.items.get(ACTIVITY_SETTINGS_KEY) ?? "")).toEqual({
      v: 1,
      mode: "header",
      opacity: 80,
    });
  });
  test("missing → defaults, writable", async () => {
    expect(await fake().store.read()).toEqual({
      settings: DEFAULT_ACTIVITY_SETTINGS,
      writable: true,
    });
  });
  for (const [name, raw] of [
    ["not JSON", "{oops"],
    ["not an object", "42"],
    ["unknown v", JSON.stringify({ v: 2, mode: "floating" })],
    ["unknown mode", JSON.stringify({ v: 1, mode: "sideways" })],
  ] as const) {
    test(`${name} → defaults, not writable`, async () => {
      expect(await fake(raw).store.read()).toEqual({
        settings: DEFAULT_ACTIVITY_SETTINGS,
        writable: false,
      });
    });
  }
  test("a read error → defaults, not writable", async () => {
    expect(await fake(null, { failGet: true }).store.read()).toEqual({
      settings: DEFAULT_ACTIVITY_SETTINGS,
      writable: false,
    });
  });
  test("a bad position in our own v1 record drops the position only", async () => {
    for (const position of [
      { edge: "top", yFraction: 0.5 },
      { edge: "middle", yFraction: 0.5 },
      { edge: "left", yFraction: 2 },
      7,
    ]) {
      const raw = JSON.stringify({ v: 1, mode: "floating", position });
      expect(await fake(raw).store.read()).toEqual({
        settings: { mode: "floating" },
        writable: true,
      });
    }
  });
});

describe("rule 2: an unknown v is preserved — a write over it is refused", () => {
  test("the newer record stays byte-identical", async () => {
    const newer = JSON.stringify({ v: 9, mode: "orbit" });
    const f = fake(newer);
    await f.store.read();
    await expect(f.store.write({ mode: "floating" })).rejects.toBeInstanceOf(
      ActivitySettingsPreserved,
    );
    expect(f.items.get(ACTIVITY_SETTINGS_KEY)).toBe(newer);
    expect(f.writes()).toBe(0);
  });
});

describe("rule 2b: a record that could not be READ is never written over", () => {
  test("after a read error, a write is refused (it may be a newer build's)", async () => {
    const f = fake(JSON.stringify({ v: 1, mode: "floating" }), { failGet: true });
    await f.store.read();
    await expect(f.store.write({ mode: "header" })).rejects.toBeInstanceOf(
      ActivitySettingsPreserved,
    );
    expect(f.writes()).toBe(0);
  });
});

describe("rule 3: a write failure rejects (Settings says didn't save)", () => {
  test("the store rejects", async () => {
    const f = fake(null, { failSet: true });
    await f.store.read();
    await expect(f.store.write({ mode: "floating" })).rejects.toThrow("disk full");
  });
});

describe("the holder (F22)", () => {
  test("loads, publishes, and reports writability", async () => {
    const f = fake(JSON.stringify({ v: 1, mode: "header" }));
    const h = createActivitySettingsHolder(f.store);
    const seen: string[] = [];
    h.subscribe((s) => seen.push(s.mode));
    expect(h.current()).toEqual(DEFAULT_ACTIVITY_SETTINGS);
    await h.load();
    expect(h.current().mode).toBe("header");
    expect(h.writable()).toBe(true);
    expect(seen).toEqual(["header"]);
  });

  test("a failed write rejects but KEEPS the pick for this run", async () => {
    const f = fake(null, { failSet: true });
    const h = createActivitySettingsHolder(f.store);
    await h.load();
    await expect(h.set({ mode: "header" })).rejects.toThrow("disk full");
    expect(h.current().mode).toBe("header");
  });

  test("a preserved record: not writable, a set is refused and changes nothing", async () => {
    const f = fake(JSON.stringify({ v: 3, mode: "floating" }));
    const h = createActivitySettingsHolder(f.store);
    await h.load();
    expect(h.writable()).toBe(false);
    await expect(h.set({ mode: "floating" })).rejects.toBeInstanceOf(ActivitySettingsPreserved);
    expect(h.current()).toEqual(DEFAULT_ACTIVITY_SETTINGS);
  });
});
