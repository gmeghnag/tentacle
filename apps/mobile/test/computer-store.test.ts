/**
 * The Keychain computer store (docs/feat/mobile-pairing-screen.md 11b.1, Design
 * "Computer store"). A fake `SecureKV` records every call AND its options, and
 * can throw on the Nth call — the crash between two writes, with no transaction
 * to hide behind.
 *
 * Each test names the mutation that must turn it red (§9), and Execution records
 * that mutation being run.
 */
import { describe, expect, test } from "bun:test";
import {
  type ComputerEntry,
  INDEX_KEY,
  type PairedComputer,
  type SecureKV,
  type SecureSetOptions,
  StoreUnreadable,
  computerKeyOf,
  createComputerStore,
} from "../src/computer-store.ts";

/** The class every write must carry (Owner Q3). A distinct number: a default cannot fake it. */
const THIS_DEVICE_ONLY = 4_242;

const computer = (id: string, over: Partial<PairedComputer> = {}): PairedComputer => ({
  id,
  name: `Mac ${id}`,
  computerKey: `key-${id}-${"k".repeat(30)}`,
  addresses: ["ws://127.0.0.1:4000/e2e"],
  deviceName: "iPhone",
  pairedAt: 1_700_000_000_000,
  ...over,
});

interface Call {
  readonly op: "get" | "set" | "delete";
  readonly key: string;
  readonly value?: string;
  readonly options?: SecureSetOptions;
}

interface FakeKV extends SecureKV {
  readonly calls: readonly Call[];
  readonly items: Map<string, string>;
  /** Make the Nth (1-based) write/delete throw, like a Keychain that fails. */
  failOn(callNumber: number): void;
  /** Make the NEXT `get` of `key` throw (an OS read error, F-K4). */
  failRead(key: string): void;
  readonly writes: () => readonly Call[];
}

function fakeKV(seed: Record<string, string> = {}): FakeKV {
  const items = new Map<string, string>(Object.entries(seed));
  const calls: Call[] = [];
  let failAt = -1;
  const readFailures = new Set<string>();
  const kv: FakeKV = {
    calls,
    items,
    failOn(callNumber: number) {
      failAt = callNumber;
    },
    failRead(key: string) {
      readFailures.add(key);
    },
    writes: () => calls.filter((call) => call.op !== "get"),
    async get(key: string) {
      calls.push({ op: "get", key });
      if (readFailures.delete(key)) {
        throw new Error("keychain read failed");
      }
      return items.get(key) ?? null;
    },
    async set(key: string, value: string, options: SecureSetOptions) {
      calls.push({ op: "set", key, value, options });
      if (calls.filter((c) => c.op !== "get").length === failAt) {
        throw new Error("keychain write failed");
      }
      items.set(key, value);
    },
    async delete(key: string) {
      calls.push({ op: "delete", key });
      if (calls.filter((c) => c.op !== "get").length === failAt) {
        throw new Error("keychain delete failed");
      }
      items.delete(key);
    },
  };
  return kv;
}

const store = (kv: SecureKV) => createComputerStore({ kv, keychainAccessible: THIS_DEVICE_ONLY });

const paired = (entries: readonly ComputerEntry[]): readonly PairedComputer[] =>
  entries.flatMap((entry) => (entry.state === "paired" ? [entry.computer] : []));

describe("the Keychain computer store", () => {
  test("round trip: two computers come back in order", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.add(computer("b"), "priv-b");
    const entries = await s.list();
    expect(entries.map((entry) => entry.state)).toEqual(["paired", "paired"]);
    expect(paired(entries)).toEqual([computer("a"), computer("b")]);
    const a = await s.get("a");
    expect(a?.deviceKey).toBe("priv-a");
    expect(a?.computerKey).toBe(computer("a").computerKey);
    expect(await s.get("missing")).toBeUndefined();
  });

  test("the private key lives ONLY in its computer's item (mutation: put it in the index → red)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    expect(kv.items.get(computerKeyOf("a"))).toContain("priv-a");
    // The index carries ids and nothing else: no key, no name, no address.
    expect(JSON.parse(kv.items.get(INDEX_KEY) ?? "null")).toEqual({ v: 1, ids: ["a"] });
  });

  test("every set carries AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (mutation: drop the option → red)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.remove("a");
    const sets = kv.calls.filter((call) => call.op === "set");
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const set of sets) {
      expect(set.options).toEqual({ keychainAccessible: THIS_DEVICE_ONLY });
    }
  });

  test("add writes the ITEM before the index: a crash on the index leaves it unlisted (mutation: swap → red)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    // Write 1 = the item, write 2 = the index: fail the second.
    kv.failOn(2);
    await expect(s.add(computer("a"), "priv-a")).rejects.toThrow("keychain write failed");
    // The item landed (an orphan — F-P13), the index did not, so it is not listed.
    expect(kv.items.has(computerKeyOf("a"))).toBe(true);
    expect(await s.list()).toEqual([]);
    // The write order is the property, not just the outcome.
    expect(kv.writes().map((call) => call.key)).toEqual([computerKeyOf("a"), INDEX_KEY]);
  });

  test("remove deletes the INDEX entry before the item: a crash on the delete still unlists it (mutation: swap → red)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.add(computer("b"), "priv-b");
    const before = kv.writes().length;
    // The remove's second write (the item delete) fails.
    kv.failOn(before + 2);
    await expect(s.remove("a")).rejects.toThrow("keychain delete failed");
    expect(await s.list()).toEqual([{ id: "b", state: "paired", computer: computer("b") }]);
    expect(
      kv
        .writes()
        .slice(before)
        .map((call) => `${call.op}:${call.key}`),
    ).toEqual([`set:${INDEX_KEY}`, `delete:${computerKeyOf("a")}`]);
  });

  test("an unknown version is StoreUnreadable and NOTHING is ever written while it stands (mutation: reset to empty → red)", async () => {
    const kv = fakeKV({ [INDEX_KEY]: JSON.stringify({ v: 99, ids: ["a"] }) });
    const s = store(kv);
    await expect(s.list()).rejects.toBeInstanceOf(StoreUnreadable);
    await expect(s.get("a")).rejects.toBeInstanceOf(StoreUnreadable);
    // An ADD must not "repair" it: a downgraded app would erase a newer app's computers.
    await expect(s.add(computer("b"), "priv-b")).rejects.toBeInstanceOf(StoreUnreadable);
    expect(kv.writes()).toEqual([]);
    // The newer app's bytes are still exactly what it wrote.
    expect(kv.items.get(INDEX_KEY)).toBe(JSON.stringify({ v: 99, ids: ["a"] }));
  });

  test("garbage in the index is StoreUnreadable too, and nothing is written", async () => {
    const kv = fakeKV({ [INDEX_KEY]: "{not json" });
    const s = store(kv);
    await expect(s.list()).rejects.toBeInstanceOf(StoreUnreadable);
    await expect(s.remove("a")).rejects.toBeInstanceOf(StoreUnreadable);
    expect(kv.writes()).toEqual([]);
  });

  test("a failed READ rejects, it is never an empty list (mutation: catch → [] → red)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    kv.failRead(INDEX_KEY);
    await expect(s.list()).rejects.toThrow("keychain read failed");
  });

  test("a missing/unreadable ITEM makes that computer `broken`; the rest still load (F-K2)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.add(computer("b"), "priv-b");
    kv.items.delete(computerKeyOf("a"));
    kv.items.set(computerKeyOf("b"), JSON.stringify({ v: 1, id: "b", name: "Mac b" }));
    const entries = await s.list();
    expect(entries).toEqual([
      { id: "a", state: "broken", name: "a" },
      { id: "b", state: "broken", name: "b" },
    ]);
    // The dial path has nothing to dial for them.
    expect(await s.get("a")).toBeUndefined();
  });

  test("re-adding an id REPLACES its record and keeps ONE index entry (Owner Q7)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-old");
    await s.add(computer("a", { name: "Mac a renamed" }), "priv-new");
    expect((await s.list()).map((entry) => entry.state)).toEqual(["paired"]);
    expect(JSON.parse(kv.items.get(INDEX_KEY) ?? "null")).toEqual({ v: 1, ids: ["a"] });
    expect((await s.get("a"))?.deviceKey).toBe("priv-new");
    expect((await s.get("a"))?.name).toBe("Mac a renamed");
  });

  test("concurrent add + remove are serialised: the index never interleaves (F-K7)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    // Fired without awaiting: both queue on the store's own write chain.
    const adding = s.add(computer("b"), "priv-b");
    const removing = s.remove("a");
    const listRightAfter = s.list();
    await Promise.all([adding, removing, listRightAfter]);
    expect(await s.list()).toEqual([{ id: "b", state: "paired", computer: computer("b") }]);
    // The index is written twice and never overlaps: each `set` sees the previous.
    const indexWrites = kv
      .writes()
      .filter((call) => call.key === INDEX_KEY)
      .map((call) => JSON.parse(call.value ?? "null").ids);
    expect(indexWrites).toEqual([["a"], ["a", "b"], ["b"]]);
    // The add's item write lands before its own index write, and the remove's
    // index write before its delete: no interleaving across the two operations.
    const order = kv.writes().map((call) => `${call.op}:${call.key}`);
    expect(order).toEqual([
      `set:${computerKeyOf("a")}`,
      `set:${INDEX_KEY}`,
      `set:${computerKeyOf("b")}`,
      `set:${INDEX_KEY}`,
      `set:${INDEX_KEY}`,
      `delete:${computerKeyOf("a")}`,
    ]);
  });
});

describe("the push registration fingerprint (docs/feat/mobile-push.md P9)", () => {
  test("setPush remembers it, and get() HANDS IT BACK (mutation: drop it from storedComputerOf → red)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.setPush("a", { hash: "64:aaa|7:sandbox|43:kkk", registeredAt: 1_700 });
    const read = await s.get("a");
    expect(read?.push).toEqual({ hash: "64:aaa|7:sandbox|43:kkk", registeredAt: 1_700 });
    // The public half never carries it: a list row cannot leak a fingerprint.
    const listed = await s.list();
    expect(listed[0]?.state === "paired" && "push" in listed[0].computer).toBe(false);
  });

  test("setPush(undefined) forgets it and keeps every other field", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.setPush("a", { hash: "h", registeredAt: 2 });
    await s.setPush("a", undefined);
    const read = await s.get("a");
    expect(read?.push).toBeUndefined();
    expect(read?.deviceKey).toBe("priv-a");
    expect(read?.addresses).toEqual(["ws://127.0.0.1:4000/e2e"]);
  });

  test("setPush for an id the index does not list writes NOTHING (no orphan item)", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.setPush("ghost", { hash: "h", registeredAt: 3 });
    expect(kv.items.get(computerKeyOf("ghost"))).toBeUndefined();
  });

  test("a malformed stored fingerprint is DROPPED, and the computer still loads", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    const raw = JSON.parse(kv.items.get(computerKeyOf("a")) ?? "{}") as Record<string, unknown>;
    kv.items.set(computerKeyOf("a"), JSON.stringify({ ...raw, push: { hash: 7 } }));
    const read = await s.get("a");
    expect(read?.push).toBeUndefined();
    expect(read?.deviceKey).toBe("priv-a");
  });

  test("an `off` DEBT round-trips through the store (mutation: return only `{hash, registeredAt}` → red)", async () => {
    // Review round 2, R2-1: the toggle-off while a computer is not connected
    // stores `{hash:"", registeredAt, off:true}`, and this reader used to
    // rebuild the record WITHOUT `off`, so the debt was invisible in the app and
    // the daemon kept pushing to a phone whose owner said stop. The type gap is
    // why TS was silent; this test is the contract that closes it.
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    await s.setPush("a", { hash: "", registeredAt: 9, off: true });
    expect((await s.get("a"))?.push).toEqual({ hash: "", registeredAt: 9, off: true });
  });

  test("an `off` that is not exactly `true` is not invented into a debt", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-a");
    const raw = JSON.parse(kv.items.get(computerKeyOf("a")) ?? "{}") as Record<string, unknown>;
    kv.items.set(
      computerKeyOf("a"),
      JSON.stringify({ ...raw, push: { hash: "h", registeredAt: 1, off: "yes" } }),
    );
    // Readable, but not this build's debt: an unregister nobody asked for is a
    // bug of its own, so the field is dropped rather than coerced.
    expect((await s.get("a"))?.push).toEqual({ hash: "h", registeredAt: 1 });
  });

  test("a RE-PAIR forgets the fingerprint: the device id changed, so the old one means nothing", async () => {
    const kv = fakeKV();
    const s = store(kv);
    await s.add(computer("a"), "priv-old");
    await s.setPush("a", { hash: "h", registeredAt: 4 });
    await s.add(computer("a"), "priv-new");
    expect((await s.get("a"))?.push).toBeUndefined();
  });
});
