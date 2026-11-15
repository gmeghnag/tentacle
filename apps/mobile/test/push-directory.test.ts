/**
 * docs/feat/mobile-notifications.md Design 6 / slice N4. The two properties that
 * make this item safe to hand an extension, each named with its mutation (AGENTS §9):
 *  - it carries NO Noise device key (asserted on the serialized BYTES, because a
 *    spread of a future field would keep the object assertion green);
 *  - a directory of an unknown version is never overwritten.
 */
import { describe, expect, test } from "bun:test";
import { encodeBase64Url } from "@tentacle/protocol";
import { pushKeyId } from "@tentacle/transport/push";
import { directoryStore, rewritePushDirectory } from "../src/push-directory-expo.ts";
import {
  type DirectoryKey,
  type DirectoryPeer,
  type DirectorySourceComputer,
  type DirectoryStore,
  PUSH_DIRECTORY_ITEM,
  PUSH_DIRECTORY_VERSION,
  PUSH_KEY_RETENTION_MS,
  deriveDirectory,
  directoryVersionOf,
  keyIsLive,
  parseDirectory,
  readDirectory,
  rotateKeys,
  writeDirectory,
} from "../src/push-directory.ts";
import { PUSH_KEY_ITEM } from "../src/push-key.ts";

const NOW = 1_800_000_000_000;
const keyBytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const b64 = (fill: number): string => encodeBase64Url(keyBytes(fill));

/** A stored computer record, WITH the secret a directory must never carry. */
const computer = (id: string, fill: number): DirectorySourceComputer & { deviceKey: string } => ({
  id,
  name: `name-${id}`,
  computerKey: b64(fill),
  deviceKey: `DEVICE-SECRET-${id}`,
});

const derive = (over: Partial<Parameters<typeof deriveDirectory>[0]> = {}) =>
  deriveDirectory({
    computers: [computer("c1", 7), computer("c2", 9)],
    keys: [{ priv: b64(21), pub: b64(22), createdAt: NOW }],
    kidOf: pushKeyId,
    decodeKey: (text) => {
      const out = new Uint8Array(32);
      const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      out.set(decoded.subarray(0, 32));
      return out.length === 32 ? out : undefined;
    },
    now: NOW,
    ...over,
  });

class MemStore implements DirectoryStore {
  readonly items = new Map<string, string>();
  writes = 0;
  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.items.set(key, value);
  }
}

describe("the directory carries what the extension needs and nothing else", () => {
  test("peers by pinned key id, keys current-first, no deviceKey anywhere in the BYTES", () => {
    // Mutation: spread the stored record into the peer (`{...computer}`) → the
    // serialized bytes carry DEVICE-SECRET and this fails.
    const directory = derive();
    const bytes = JSON.stringify(directory);
    expect(bytes).not.toContain("DEVICE-SECRET");
    expect(bytes).not.toContain("deviceKey");
    expect(directory.v).toBe(PUSH_DIRECTORY_VERSION);
    expect(directory.peers).toEqual([
      { kid: pushKeyId(keyBytes(7)), computerId: "c1", name: "name-c1", computerKey: b64(7) },
      { kid: pushKeyId(keyBytes(9)), computerId: "c2", name: "name-c2", computerKey: b64(9) },
    ]);
    expect(directory.keys).toEqual([{ priv: b64(21), pub: b64(22), createdAt: NOW }]);
  });

  test("a computer whose key does not decode keeps its place in the app, not in the extension", () => {
    const directory = derive({
      computers: [
        { id: "c1", name: "n1", computerKey: "not-a-key!" },
        { id: "c2", name: "n2", computerKey: b64(9) },
      ],
      decodeKey: (text) => (text === b64(9) ? keyBytes(9) : undefined),
    });
    expect(directory.peers.map((p) => p.computerId)).toEqual(["c2"]);
  });

  test("an empty app writes an empty directory, not a broken one", () => {
    expect(derive({ computers: [], keys: [] })).toEqual({
      v: PUSH_DIRECTORY_VERSION,
      peers: [],
      keys: [],
    });
  });
});

describe("key retention across a rotation (F8, plan C2)", () => {
  const current = { privateKey: b64(31), publicKey: b64(32) };
  const previous = { privateKey: b64(41), publicKey: b64(42) };

  test("a rewrite with the SAME key is not a rotation: the original createdAt survives", () => {
    const retained: DirectoryKey[] = [{ priv: b64(31), pub: b64(32), createdAt: NOW - 1000 }];
    expect(rotateKeys({ current, retained, now: NOW })).toEqual(retained);
  });

  test("a rotation retires the previous key instead of dropping it", () => {
    // Mutation: return only the current key → red: pushes sealed a second before
    // the rotation stop opening (F8).
    const retired = rotateKeys({ current, retained: [], previous, now: NOW });
    expect(retired).toEqual([
      { priv: b64(31), pub: b64(32), createdAt: NOW },
      { priv: b64(41), pub: b64(42), createdAt: NOW, retiredAt: NOW },
    ]);
  });

  test("a retired key is dropped exactly 24 h after retirement, ±1 ms", () => {
    const retiredAt = NOW - PUSH_KEY_RETENTION_MS;
    const inside: DirectoryKey = { priv: b64(41), pub: b64(42), createdAt: 0, retiredAt };
    expect(keyIsLive(inside, NOW)).toBe(true);
    expect(keyIsLive({ ...inside, retiredAt: NOW - PUSH_KEY_RETENTION_MS - 1 }, NOW)).toBe(false);
    // The derivation drops it, so the extension never holds a key it may not use.
    expect(
      derive({ keys: [{ ...inside, retiredAt: NOW - PUSH_KEY_RETENTION_MS - 1 }] }).keys,
    ).toEqual([]);
    expect(derive({ keys: [inside] }).keys).toHaveLength(1);
  });

  test("a rotation keeps an already-retired key's own stamp (no re-extension by rewriting)", () => {
    const older: DirectoryKey = {
      priv: b64(51),
      pub: b64(52),
      createdAt: 1,
      retiredAt: NOW - PUSH_KEY_RETENTION_MS + 5,
    };
    const keys = rotateKeys({ current, retained: [older], previous, now: NOW });
    expect(keys.map((k) => k.priv)).toEqual([b64(31), b64(41), b64(51)]);
    expect(keys.find((k) => k.priv === b64(51))?.retiredAt).toBe(NOW - PUSH_KEY_RETENTION_MS + 5);
  });
});

describe("versioning: an unknown directory is refused, never overwritten", () => {
  test("parse: absent / unreadable / unknown version → undefined (treated as absent)", () => {
    expect(parseDirectory(null)).toBeUndefined();
    expect(parseDirectory("not json")).toBeUndefined();
    expect(parseDirectory(JSON.stringify({ v: 2, peers: [], keys: [] }))).toBeUndefined();
    expect(parseDirectory(JSON.stringify({ v: 1, peers: [], keys: [] }))?.v).toBe(1);
    expect(directoryVersionOf(JSON.stringify({ v: 2 }))).toBe(2);
    expect(directoryVersionOf("garbage")).toBeUndefined();
  });

  test("the writer refuses a NEWER directory and leaves its bytes untouched", async () => {
    // Mutation: write anyway → the newer build's item is destroyed (AGENTS §7).
    const store = new MemStore();
    const newer = JSON.stringify({ v: 2, peers: [], keys: [], future: true });
    store.items.set(PUSH_DIRECTORY_ITEM, newer);
    expect(await writeDirectory(store, derive())).toBe("version");
    expect(store.items.get(PUSH_DIRECTORY_ITEM)).toBe(newer);
    expect(store.writes).toBe(0);
  });

  test("an absent or same-version item is written; a read after it round-trips", async () => {
    const store = new MemStore();
    const directory = derive();
    expect(await writeDirectory(store, directory)).toBe("written");
    expect(await readDirectory(store)).toEqual(directory);
    // Overwriting our own version is fine (that is what a re-pair does).
    expect(await writeDirectory(store, derive({ computers: [] }))).toBe("written");
    expect((await readDirectory(store))?.peers).toEqual([]);
  });
});

describe("the items are named in one place", () => {
  test("the directory item is not the push key item (the extension reads both)", async () => {
    const { PUSH_KEY_ITEM } = await import("../src/push-key.ts");
    expect(PUSH_DIRECTORY_ITEM).toBe("tentacle.push.directory");
    expect(PUSH_KEY_ITEM).toBe("tentacle.push-key");
  });

  test("a peer type is exactly what the extension may match an envelope against", () => {
    const peer: DirectoryPeer = derive().peers[0] as DirectoryPeer;
    expect(Object.keys(peer).sort()).toEqual(["computerId", "computerKey", "kid", "name"]);
  });
});

// docs/feat/mobile-notifications.md Design 6 / N4: the adapter's rewrite. Injected
// seams only (a fake store, a fake shared-group Keychain), so the ORDER and the
// allowlist are pinned without a simulator.
describe("rewritePushDirectory (the adapter)", () => {
  const keypair = { privateKey: b64(61), publicKey: b64(62) };

  /** A fake `PushKeyStore` over one map, recording every access group it was asked for. */
  function keychain() {
    const items = new Map<string, string>();
    const groups: string[] = [];
    return {
      items,
      groups,
      store: {
        async get(key: string, options: { accessGroup: string }): Promise<string | null> {
          groups.push(options.accessGroup);
          return items.get(key) ?? null;
        },
        async set(
          key: string,
          value: string,
          options: { accessGroup: string; keychainAccessible: number },
        ): Promise<void> {
          groups.push(options.accessGroup);
          items.set(key, value);
        },
        async delete(key: string, options: { accessGroup: string }): Promise<void> {
          groups.push(options.accessGroup);
          items.delete(key);
        },
      },
    };
  }

  /** A fake `ComputerStore.list()`: the paired entries, plus one broken item. */
  const computerStore = (entries: readonly ("paired" | "broken")[]) =>
    ({
      list: async () =>
        entries.map((state, index) =>
          state === "paired"
            ? {
                id: `c${index}`,
                state: "paired" as const,
                computer: {
                  id: `c${index}`,
                  name: `n${index}`,
                  computerKey: b64(70 + index),
                  deviceKey: `DEVICE-SECRET-${index}`,
                  addresses: [],
                  deviceName: "phone",
                  pairedAt: NOW,
                },
              }
            : { id: `c${index}`, state: "broken" as const, name: `n${index}` },
        ),
    }) as unknown as Parameters<typeof rewritePushDirectory>[0]["store"];

  test("writes into the SHARED group, from the public half only, skipping broken records", async () => {
    const chain = keychain();
    // The push key item, as a previous run left it.
    chain.items.set(PUSH_KEY_ITEM, JSON.stringify({ v: 1, ...keypair }));
    const result = await rewritePushDirectory({
      store: computerStore(["paired", "broken", "paired"]),
      directory: directoryStore(chain.store, 1),
      keys: chain.store,
      keychainAccessible: 1,
      random: () => new Uint8Array(32).fill(5),
      now: NOW,
    });
    expect(result).toBe("written");
    const raw = chain.items.get(PUSH_DIRECTORY_ITEM);
    expect(raw).toBeDefined();
    expect(raw).not.toContain("DEVICE-SECRET");
    const written = JSON.parse(raw ?? "{}");
    expect(written.v).toBe(1);
    expect(written.peers.map((p: { computerId: string }) => p.computerId)).toEqual(["c0", "c2"]);
    expect(written.keys).toEqual([{ priv: b64(61), pub: b64(62), createdAt: NOW }]);
    // Every access was against the shared group, never the app's own item group.
    expect(new Set(chain.groups)).toEqual(new Set(["so.tentacle.app"]));
  });

  test("a re-pair REPLACES the peer (new pinned key, same computer id)", async () => {
    // Mutation: skip the rewrite on a store change → the old key stays and the
    // extension renders pushes that no longer authenticate (F9).
    const chain = keychain();
    chain.items.set(PUSH_KEY_ITEM, JSON.stringify({ v: 1, ...keypair }));
    await rewritePushDirectory({
      store: computerStore(["paired"]),
      directory: directoryStore(chain.store, 1),
      keys: chain.store,
      keychainAccessible: 1,
      random: () => new Uint8Array(32).fill(5),
      now: NOW,
    });
    const before = JSON.parse(chain.items.get(PUSH_DIRECTORY_ITEM) ?? "{}");
    await rewritePushDirectory({
      store: {
        list: async () => [
          {
            id: "c0",
            state: "paired" as const,
            computer: {
              id: "c0",
              name: "n0",
              computerKey: b64(99), // the re-paired key
              deviceKey: "DEVICE-SECRET-0",
              addresses: [],
              deviceName: "phone",
              pairedAt: NOW,
            },
          },
        ],
      } as unknown as Parameters<typeof rewritePushDirectory>[0]["store"],
      directory: directoryStore(chain.store, 1),
      keys: chain.store,
      keychainAccessible: 1,
      random: () => new Uint8Array(32).fill(5),
      now: NOW,
    });
    const after = JSON.parse(chain.items.get(PUSH_DIRECTORY_ITEM) ?? "{}");
    expect(after.peers).toHaveLength(1);
    expect(after.peers[0].computerKey).toBe(b64(99));
    expect(after.peers[0].computerKey).not.toBe(before.peers[0].computerKey);
  });

  test("the current key keeps its original createdAt; a newer report is surfaced, not thrown", async () => {
    const chain = keychain();
    chain.items.set(PUSH_KEY_ITEM, JSON.stringify({ v: 1, ...keypair }));
    chain.items.set(PUSH_DIRECTORY_ITEM, JSON.stringify({ v: 2, peers: [], keys: [] }));
    expect(
      await rewritePushDirectory({
        store: computerStore([]),
        directory: directoryStore(chain.store, 1),
        keys: chain.store,
        keychainAccessible: 1,
        random: () => new Uint8Array(32).fill(5),
        now: NOW,
      }),
    ).toBe("version");
    expect(chain.items.get(PUSH_DIRECTORY_ITEM)).toBe(
      JSON.stringify({ v: 2, peers: [], keys: [] }),
    );
  });
});
