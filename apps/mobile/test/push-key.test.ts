/**
 * The push key (docs/feat/mobile-push.md slice P9): one X25519 key pair per
 * phone, in the SHARED Keychain access group so task 17's extension can open a
 * push while the app is not running.
 *
 * The load-bearing properties, each pinned by a test below:
 *  - **it is not the Noise device key** (a separate item, a separate key): an
 *    extension that can decrypt a notification cannot authenticate as the phone;
 *  - **written once, never rotated behind the computers' backs** — a key that
 *    exists is returned as-is;
 *  - **every write and read carries the shared access group**. `kSecAttrAccessGroup`
 *    is part of an item's KEY on iOS, not a write-only attribute: reading it back
 *    without the group silently finds nothing, so the group travels on all three
 *    calls (mutation: drop it from `get` → the "reads back" test fails);
 *  - **`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`**, so the extension can read it while
 *    the phone is locked, and a restored backup still cannot.
 */
import { describe, expect, test } from "bun:test";
import { decodeBase64Url } from "@tentacle/protocol";
import { publicKeyOf } from "@tentacle/transport/push";
import { PUSH_GROUP, TEAM_ID } from "../src/push-access-group.ts";
import {
  PUSH_KEY_ACCESS_GROUP,
  PUSH_KEY_ITEM,
  type PushKeyLookup,
  type PushKeySetOptions,
  type PushKeyStore,
  deletePushKeypair,
  ensurePushKeypair,
} from "../src/push-key.ts";

/** The class every write must carry: a distinct number, so a default cannot fake it. */
const THIS_DEVICE_ONLY = 4_242;

interface Call {
  readonly op: "get" | "set" | "delete";
  readonly key: string;
  readonly options?: PushKeySetOptions | PushKeyLookup;
}

interface FakeStore extends PushKeyStore {
  readonly calls: readonly Call[];
  readonly items: Map<string, string>;
}

/** A Keychain that is keyed by `(accessGroup, key)` — as iOS actually behaves. */
function fakeStore(): FakeStore {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const slot = (key: string, group: string): string => `${group}\u0000${key}`;
  return {
    calls,
    items,
    get: async (key, options) => {
      calls.push({ op: "get", key, options });
      return items.get(slot(key, options.accessGroup)) ?? null;
    },
    set: async (key, value, options) => {
      calls.push({ op: "set", key, options });
      items.set(slot(key, options.accessGroup), value);
    },
    delete: async (key, options) => {
      calls.push({ op: "delete", key, options });
      items.delete(slot(key, options.accessGroup));
    },
  };
}

const random = (n: number): Uint8Array => new Uint8Array(n).fill(9);

describe("ensurePushKeypair", () => {
  test("generates a real X25519 pair on first use (public = publicKeyOf(private))", async () => {
    const store = fakeStore();
    const pair = await ensurePushKeypair({ store, random, keychainAccessible: THIS_DEVICE_ONLY });
    const priv = decodeBase64Url(pair.privateKey);
    expect(priv?.length).toBe(32);
    const pub = decodeBase64Url(pair.publicKey);
    expect(pub?.length).toBe(32);
    // The declared half IS the derived half: a stored pair a daemon seals to and
    // an extension opens with cannot be two unrelated keys.
    expect(pub).toEqual(publicKeyOf(priv ?? new Uint8Array()));
  });

  test("a second call returns the SAME key and writes nothing (mutation: always regenerate → red)", async () => {
    const store = fakeStore();
    const first = await ensurePushKeypair({ store, random, keychainAccessible: THIS_DEVICE_ONLY });
    const writes = store.calls.filter((call) => call.op === "set").length;
    const second = await ensurePushKeypair({
      store,
      random: (n) => new Uint8Array(n).fill(200),
      keychainAccessible: THIS_DEVICE_ONLY,
    });
    expect(second).toEqual(first);
    expect(store.calls.filter((call) => call.op === "set").length).toBe(writes);
  });

  test("every call carries the SHARED access group, and the write this-device-only (mutation: drop the group from get → red)", async () => {
    const store = fakeStore();
    await ensurePushKeypair({
      store,
      random,
      keychainAccessible: THIS_DEVICE_ONLY,
      accessGroup: "group.test",
    });
    // Set the group on the WRITE only and the read-back would find nothing, so
    // the second call is the assertion: it must see what the first wrote.
    const again = await ensurePushKeypair({
      store,
      random: (n) => new Uint8Array(n).fill(1),
      keychainAccessible: THIS_DEVICE_ONLY,
      accessGroup: "group.test",
    });
    expect(again).toBeDefined();
    for (const call of store.calls) {
      expect(call.options?.accessGroup).toBe("group.test");
    }
    for (const call of store.calls.filter((one) => one.op === "set")) {
      expect((call.options as PushKeySetOptions).keychainAccessible).toBe(THIS_DEVICE_ONLY);
    }
    expect(store.calls.filter((one) => one.op === "set").length).toBe(1);
  });

  test("the default group is the SHARED (push) group, TEAMID-prefixed", async () => {
    // Fix round 1, findings #3/#4: the extension is entitled to the separate
    // `...so.tentacle.app.push` group and the value must be the BUILT
    // entitlement, i.e. the team id in front of it (`kSecAttrAccessGroup`
    // matches nothing else). Mutation: the bare bundle id → no match on a device.
    const store = fakeStore();
    await ensurePushKeypair({ store, random, keychainAccessible: THIS_DEVICE_ONLY });
    expect(store.calls[0]?.options?.accessGroup).toBe(PUSH_KEY_ACCESS_GROUP);
    expect(PUSH_KEY_ACCESS_GROUP).toBe(`${TEAM_ID}.${PUSH_GROUP}`);
    expect(PUSH_GROUP).toBe("so.tentacle.app.push");
  });

  test("it is a SEPARATE item from the computers' (never `tentacle.computer.*`)", async () => {
    const store = fakeStore();
    await ensurePushKeypair({ store, random, keychainAccessible: THIS_DEVICE_ONLY });
    expect(PUSH_KEY_ITEM.startsWith("tentacle.computer.")).toBe(false);
    expect(PUSH_KEY_ITEM).toBe("tentacle.push-key");
  });

  test("an unreadable item or an unknown version is REPLACED (there is nothing to preserve)", async () => {
    for (const junk of ["not json", JSON.stringify({ v: 99, privateKey: "x", publicKey: "y" })]) {
      const store = fakeStore();
      store.items.set(`${PUSH_KEY_ACCESS_GROUP}\u0000${PUSH_KEY_ITEM}`, junk);
      const pair = await ensurePushKeypair({ store, random, keychainAccessible: THIS_DEVICE_ONLY });
      expect(decodeBase64Url(pair.privateKey)?.length).toBe(32);
      // And the replacement is stored, not just returned.
      expect(store.calls.filter((call) => call.op === "set").length).toBe(1);
    }
  });

  test("deletePushKeypair removes the item in the same group, and the next call makes a new key", async () => {
    const store = fakeStore();
    const first = await ensurePushKeypair({ store, random, keychainAccessible: THIS_DEVICE_ONLY });
    await deletePushKeypair({ store });
    expect(store.calls.some((call) => call.op === "delete")).toBe(true);
    const second = await ensurePushKeypair({
      store,
      random: (n) => new Uint8Array(n).fill(3),
      keychainAccessible: THIS_DEVICE_ONLY,
    });
    expect(second.privateKey).not.toBe(first.privateKey);
  });
});
