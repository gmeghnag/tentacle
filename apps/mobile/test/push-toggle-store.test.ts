/**
 * The Notifications switch on disk (docs/feat/mobile-push.md P9, review round 1
 * finding H1). Pure: a fake `SecureKV`, no Keychain, no simulator.
 *
 * The three rules pinned here are `lock-settings-store.ts`'s, applied to the one
 * item where the DEFAULT decides whether a person's phone buzzes:
 * absent/unreadable/unknown reads ON (never silently mute), an unknown version is
 * never overwritten, and a write error rejects so the caller keeps the decision
 * in memory instead of believing it landed.
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV } from "../src/computer-store.ts";
import {
  PUSH_TOGGLE_KEY,
  PUSH_TOGGLE_VERSION,
  createPushToggleStore,
} from "../src/push-toggle-store.ts";

/** A `SecureKV` in a Map, with the failure switches each rule needs. */
function kv(
  initial: Record<string, string> = {},
): SecureKV & { readonly items: Map<string, string>; failRead?: boolean; failWrite?: boolean } {
  const items = new Map(Object.entries(initial));
  const fake = {
    items,
    failRead: false,
    failWrite: false,
    get: async (key: string) => {
      if (fake.failRead) {
        throw new Error("keychain unavailable");
      }
      return items.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      if (fake.failWrite) {
        throw new Error("disk full");
      }
      items.set(key, value);
    },
    delete: async (key: string) => {
      items.delete(key);
    },
  };
  return fake;
}

const store = (fake: SecureKV) => createPushToggleStore({ kv: fake, keychainAccessible: 1 });

describe("a fresh install reads ON (off is a decision the person must make)", () => {
  test("absent reads on, and is writable", async () => {
    expect(await store(kv()).read()).toEqual({ enabled: true, writable: true });
  });

  test("off round-trips, so a relaunch sees it (mutation: read the default always → red)", async () => {
    const fake = kv();
    await store(fake).write(false);
    expect(fake.items.get(PUSH_TOGGLE_KEY)).toBe(
      JSON.stringify({ v: PUSH_TOGGLE_VERSION, enabled: false }),
    );
    expect(await store(fake).read()).toEqual({ enabled: false, writable: true });
    await store(fake).write(true);
    expect(await store(fake).read()).toEqual({ enabled: true, writable: true });
  });
});

describe("a record this build cannot read reads ON and is left untouched", () => {
  test("an unknown version is not overwritten (a newer build's decision survives)", async () => {
    const raw = JSON.stringify({ v: PUSH_TOGGLE_VERSION + 1, enabled: false });
    const fake = kv({ [PUSH_TOGGLE_KEY]: raw });
    expect(await store(fake).read()).toEqual({ enabled: true, writable: false });
    // Reading never writes.
    expect(fake.items.get(PUSH_TOGGLE_KEY)).toBe(raw);
  });

  test("garbage bytes, a non-object, and a non-boolean `enabled` all read ON, unwritable", async () => {
    for (const raw of ["not json", "[]", JSON.stringify({ v: PUSH_TOGGLE_VERSION })]) {
      expect(await store(kv({ [PUSH_TOGGLE_KEY]: raw })).read()).toEqual({
        enabled: true,
        writable: false,
      });
    }
  });

  test("a READ error reads ON and unwritable (never a silent mute)", async () => {
    const fake = kv();
    fake.failRead = true;
    expect(await store(fake).read()).toEqual({ enabled: true, writable: false });
  });
});

describe("a write failure REJECTS (so the caller can keep the decision in memory)", () => {
  test("the rejection reaches the caller rather than being swallowed here", async () => {
    const fake = kv();
    fake.failWrite = true;
    await expect(store(fake).write(false)).rejects.toThrow("disk full");
  });
});
