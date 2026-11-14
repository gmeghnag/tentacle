/**
 * `lock-settings-store.ts` — the persisted lock delay (docs/feat/mobile-lock.md
 * D3, Tests): round-trip; missing / garbage / `v:2` → `5m` with the bytes
 * untouched; a read error → `5m`; and the write guard that keeps a newer
 * build's record intact.
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV, SecureSetOptions } from "../src/computer-store.ts";
import {
  DEFAULT_LOCK_DELAY,
  LOCK_SETTING_KEY,
  LOCK_SETTING_VERSION,
  LockSettingPreserved,
  createLockSettingStore,
  guardLockSettingStore,
  isLockDelay,
} from "../src/lock-settings-store.ts";

const ACCESSIBLE = 6;

/** An in-memory Keychain: records what was written, so "untouched" is provable. */
function fakeKV(initial: string | null = null) {
  const items = new Map<string, string>();
  if (initial !== null) {
    items.set(LOCK_SETTING_KEY, initial);
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
    store: createLockSettingStore({ kv: fake.kv, keychainAccessible: ACCESSIBLE }),
  };
}

describe("round-trip", () => {
  test("every delay survives a write and a read", async () => {
    for (const delay of ["immediately", "5m", "1h", "never"] as const) {
      const s = store();
      await s.store.write(delay);
      expect((await s.store.read()).delay).toBe(delay);
    }
  });

  test("the written record is the versioned shape, with the Keychain class", async () => {
    const s = store();
    await s.store.write("1h");
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0]?.key).toBe(LOCK_SETTING_KEY);
    expect(s.writes[0]?.options.keychainAccessible).toBe(ACCESSIBLE);
    expect(JSON.parse(s.writes[0]?.value ?? "{}")).toEqual({
      v: LOCK_SETTING_VERSION,
      delay: "1h",
    });
  });
});

describe("F11 — a broken record reads 5m and is never `never`", () => {
  test("an ABSENT record is the default, and is writable (a fresh install)", async () => {
    const read = await store().store.read();
    expect(read).toEqual({ delay: DEFAULT_LOCK_DELAY, writable: true });
    expect(DEFAULT_LOCK_DELAY).toBe("5m");
  });

  test("GARBAGE reads 5m and the bytes are left untouched", async () => {
    const s = store("not json at all");
    const read = await s.store.read();
    expect(read.delay).toBe("5m");
    expect(read.writable).toBe(false);
    expect(s.items.get(LOCK_SETTING_KEY)).toBe("not json at all");
  });

  test("an unknown version (v:2) reads 5m and the bytes are left untouched", async () => {
    const newer = JSON.stringify({ v: LOCK_SETTING_VERSION + 1, delay: "never" });
    const s = store(newer);
    const read = await s.store.read();
    // `never` in a newer record must NOT disable this build's lock.
    expect(read.delay).toBe("5m");
    expect(read.writable).toBe(false);
    expect(s.items.get(LOCK_SETTING_KEY)).toBe(newer);
  });

  test("a v:1 record with an unknown delay reads 5m (a closed union, not trust)", async () => {
    const read = await store(JSON.stringify({ v: 1, delay: "2h" })).store.read();
    expect(read.delay).toBe("5m");
    expect(read.writable).toBe(false);
  });

  test("a Keychain READ ERROR still yields the default", async () => {
    const kv: SecureKV = {
      get: async () => {
        throw new Error("keychain unavailable");
      },
      set: async () => {},
      delete: async () => {},
    };
    const read = await createLockSettingStore({ kv, keychainAccessible: ACCESSIBLE }).read();
    expect(read).toEqual({ delay: "5m", writable: false });
  });

  test("isLockDelay accepts exactly the four delays", () => {
    expect(["immediately", "5m", "1h", "never"].every(isLockDelay)).toBe(true);
    expect(isLockDelay("2h")).toBe(false);
    expect(isLockDelay(undefined)).toBe(false);
    expect(isLockDelay(null)).toBe(false);
  });
});

describe("the write guard keeps a newer build's record", () => {
  test("a write after an unreadable read is REFUSED, and nothing is written", async () => {
    const newer = JSON.stringify({ v: 2, delay: "never" });
    const s = store(newer);
    const guarded = guardLockSettingStore(s.store);
    await guarded.read();
    expect(guarded.preserved()).toBe(true);
    await expect(guarded.write("immediately")).rejects.toThrow(LockSettingPreserved);
    expect(s.items.get(LOCK_SETTING_KEY)).toBe(newer);
    expect(s.writes).toHaveLength(0);
  });

  test("a readable record writes normally", async () => {
    const s = store();
    const guarded = guardLockSettingStore(s.store);
    await guarded.read();
    expect(guarded.preserved()).toBe(false);
    await guarded.write("1h");
    expect((await s.store.read()).delay).toBe("1h");
  });
});
