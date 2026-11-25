/**
 * The app's push wiring (docs/feat/mobile-push.md P9): a manager over the pure
 * registrar, exercised with fakes — no Keychain, no OS, no link.
 *
 * The properties pinned here are the WIRING's (the registrar's own rules are
 * `push-registration.test.ts`'s): the row says the truth, the switch is disabled
 * exactly when flipping it would be a lie, the permission is asked once, and a
 * computer's registrar is never another computer's.
 */
import { describe, expect, test } from "bun:test";
import { createComputerStore } from "../src/computer-store.ts";
import {
  type PushClient,
  type PushMemoryStore,
  type PushPlatform,
  createPushManager,
  keychainPushMemory,
  notificationsView,
} from "../src/push-manager.ts";
import type { PushFacts, PushPermission } from "../src/push-registration.ts";
import type { PushToggleStore } from "../src/push-toggle-store.ts";

const TOKEN = "a".repeat(64);
const KEY = "k".repeat(43);
const facts = (): PushFacts => ({ token: TOKEN, env: "sandbox", key: KEY });

/** A Keychain store with push items only (the rest of a record is not this test's). */
function fakeStore(): PushMemoryStore & {
  readonly items: Map<string, { hash: string; registeredAt: number; off?: true }>;
} {
  const items = new Map<string, { hash: string; registeredAt: number; off?: true }>();
  return {
    items,
    get: async (id) => {
      const push = items.get(id);
      if (push === undefined) {
        return undefined;
      }
      return {
        id,
        name: id,
        computerKey: "c".repeat(43),
        addresses: [],
        deviceName: "iPhone",
        pairedAt: 1,
        deviceKey: "d".repeat(43),
        push,
      };
    },
    setPush: async (id, value) => {
      if (value === undefined) {
        items.delete(id);
        return;
      }
      items.set(id, value);
    },
  };
}

/**
 * The phone-wide switch, in a variable: the Keychain item `push-toggle-store.ts`
 * owns in the app. `undefined` initial = a fresh install (nothing stored).
 */
function fakeToggle(
  initial?: boolean,
  /** A record this build cannot read (`writable: false`) — never written over (R2-2). */
  unwritable?: boolean,
): PushToggleStore & {
  readonly stored: () => boolean | undefined;
  readonly writes: () => number;
  failWrite?: boolean;
} {
  let value = initial;
  let writes = 0;
  const fake = {
    stored: () => value,
    writes: () => writes,
    failWrite: false,
    read: async () => ({ enabled: value ?? true, writable: unwritable !== true }),
    write: async (enabled: boolean) => {
      if (fake.failWrite) {
        throw new Error("disk full");
      }
      writes += 1;
      value = enabled;
    },
  };
  return fake;
}

function platform(over: Partial<PushPlatform> = {}): PushPlatform & { requests: () => number } {
  let requests = 0;
  const base = {
    permission: over.permission ?? (async () => "granted" as PushPermission),
    request: async () => {
      requests += 1;
      // The DEFAULT request grants; a test that needs another answer counts the
      // call through its own `request`.
      return over.request === undefined ? ("granted" as PushPermission) : over.request();
    },
    asked: over.asked ?? (async () => false),
    facts: over.facts ?? (async () => facts()),
  };
  return { ...base, requests: () => requests };
}

function fakeClient(): PushClient & {
  readonly registers: PushFacts[];
  readonly unregisters: () => number;
} {
  const registers: PushFacts[] = [];
  let unregisters = 0;
  return {
    registers,
    unregisters: () => unregisters,
    pushRegister: async (seen) => {
      registers.push(seen);
      return { push: "on" as const, graceSeconds: 30 };
    },
    pushUnregister: async () => {
      unregisters += 1;
    },
  };
}

describe("keychainPushMemory", () => {
  test("reads the computer's own record, and a missing one reads as never registered", async () => {
    const store = fakeStore();
    const memory = keychainPushMemory(store, "c1");
    expect(await memory.read("c1")).toBeUndefined();
    await memory.write("c1", { hash: "h", registeredAt: 7 });
    expect(await memory.read("c1")).toEqual({ hash: "h", registeredAt: 7 });
    await memory.write("c1", undefined);
    expect(await memory.read("c1")).toBeUndefined();
  });
});

describe("the manager registers through the link it is given", () => {
  test("one sync registers; a second sync with the same facts sends nothing", async () => {
    const store = fakeStore();
    const platformFake = platform();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platformFake,
      now: () => 1,
    });
    const client = fakeClient();
    await manager.sync("c1", () => client);
    await manager.sync("c1", () => client);
    expect(client.registers).toEqual([facts()]);
    expect(manager.stateOf("c1")?.phase).toBe("on");
  });

  test("a relaunch REGISTERS again: the dedupe is per process, not per Keychain record", async () => {
    // The inverse of what this asserted before `fix/mobile-push-not-registered`:
    // the Keychain fingerprint outlives the daemon's copy and cannot know it was
    // deleted (an APNs `gone`), so carrying it across launches made one `gone`
    // permanent — the phone never registered again. A fresh manager is a fresh
    // launch, and a launch re-registers; what still never repeats is a re-CONNECT
    // inside one launch (the test above).
    const store = fakeStore();
    const first = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const client = fakeClient();
    await first.sync("c1", () => client);
    // A relaunch: a fresh manager, the same store (the Keychain record survives).
    const second = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 2,
    });
    await second.sync("c1", () => client);
    expect(client.registers.length).toBe(2);
  });

  test("two computers do not share a registrar or a fingerprint", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const one = fakeClient();
    const two = fakeClient();
    await manager.sync("c1", () => one);
    await manager.sync("c2", () => two);
    await manager.sync("c1", () => one);
    expect(one.registers.length).toBe(1);
    expect(two.registers.length).toBe(1);
  });

  test("a link that went away is not an exception the caller sees (the next connect retries)", async () => {
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.sync("c1", () => undefined);
    expect(manager.stateOf("c1")?.phase).toBe("failed");
  });

  test("the toggle off asks the computer to forget this device", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const client = fakeClient();
    await manager.sync("c1", () => client);
    await manager.setEnabled("c1", false, () => client);
    expect(client.unregisters()).toBe(1);
    expect(store.items.get("c1")).toBeUndefined();
  });
});

describe("the Settings row", () => {
  test("a stale phase behind a denied permission reads as the PERMISSION, not the daemon", () => {
    // The person's own iPhone setting is the actionable fact: saying "off on this
    // computer" would send them to the wrong place.
    const view = notificationsView({ enabled: true, phase: "on" }, "Mac", "denied");
    expect(view.detail).toContain("iOS Settings");
    expect(view.switchable).toBe(false);
  });

  test("a computer too old to listen is not switchable (mutation: ignore the phase → red)", () => {
    const view = notificationsView({ enabled: true, phase: "daemon-too-old" }, "Mac", "granted");
    expect(view.switchable).toBe(false);
    expect(view.detail).toContain("Update tentacle on Mac");
  });

  test("an ordinary on/off computer IS switchable", () => {
    expect(notificationsView({ enabled: true, phase: "on" }, "Mac", "granted").switchable).toBe(
      true,
    );
    expect(notificationsView({ enabled: false, phase: "off" }, "Mac", "granted").switchable).toBe(
      true,
    );
  });

  test("the manager answers a row even before any link came up (nothing is claimed as `on`)", () => {
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    const view = manager.view("ghost", "Mac", "granted");
    expect(view?.enabled).toBe(true);
    expect(view?.detail).toContain("Not checked yet");
  });
});

describe("the permission prompt", () => {
  test("asked once, after a pairing, while the OS still says `undetermined`", async () => {
    let permission: PushPermission = "undetermined";
    const platformFake = platform({
      permission: async () => permission,
      request: async () => {
        permission = "granted";
        return "granted";
      },
    });
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: platformFake,
      now: () => 1,
    });
    await manager.paired("c1", true);
    await manager.paired("c1", true);
    // Once: the second call sees a permission that is no longer undetermined.
    expect(platformFake.requests()).toBe(1);
  });

  test("never asked when there is no computer stored, or the permission is already decided", async () => {
    const undetermined = platform({ permission: async () => "undetermined" });
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: undetermined,
      now: () => 1,
    });
    await manager.paired("c1", false);
    expect(undetermined.requests()).toBe(0);
    const decided = platform({ permission: async () => "denied" });
    const second = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: decided,
      now: () => 1,
    });
    await second.paired("c1", true);
    expect(decided.requests()).toBe(0);
  });
});

describe("the ONE Settings row, over every paired computer", () => {
  test("no computer: the row is on by default and says nothing was checked", () => {
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    const view = manager.viewForAll([], "granted");
    expect(view.enabled).toBe(true);
    expect(view.detail).toContain("Not checked yet");
    // And not switchable: a tap with no computer to reach would do nothing.
    expect(view.switchable).toBe(false);
  });

  test("a computer that cannot deliver OUTRANKS one that can (it is why nothing arrives)", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const good: PushClient = {
      pushRegister: async () => ({ push: "on", graceSeconds: 30 }),
      pushUnregister: async () => {},
    };
    // A relay with no APNs key (F4). Its status was never stored as `on`, so the
    // NEXT connect asks again — the honest reading of "on" is a registration the
    // daemon acted on, and this one it did not.
    const broken: PushClient = {
      pushRegister: async () => ({ push: "relay-no-push", graceSeconds: 30 }),
      pushUnregister: async () => {},
    };
    await manager.sync("good", () => good);
    await manager.sync("broken", () => broken);
    const view = manager.viewForAll(
      [
        { id: "good", name: "Mac A" },
        { id: "broken", name: "Mac B" },
      ],
      "granted",
    );
    expect(view.detail).toContain("relay does not deliver");
    // The row is still ON: the phone wants notifications, one computer cannot
    // deliver them, and the copy says which.
    expect(view.enabled).toBe(true);
  });

  test("the toggle reaches EVERY computer, so turning it off really stops them all", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const one = fakeClient();
    const two = fakeClient();
    const links = new Map([
      ["c1", one],
      ["c2", two],
    ]);
    await manager.setEnabledForAll(
      [{ id: "c1" }, { id: "c2" }],
      false,
      (id) => () => links.get(id),
    );
    expect(one.unregisters()).toBe(1);
    expect(two.unregisters()).toBe(1);
    expect(store.items.size).toBe(0);
    // And the row is off.
    expect(
      manager.viewForAll(
        [
          { id: "c1", name: "A" },
          { id: "c2", name: "B" },
        ],
        "granted",
      ).enabled,
    ).toBe(false);
  });
});

/**
 * Review round 1 (§9: each of these was RED on the reviewed code — see Execution
 * "Fix round 1" for the runs, and the mutation that must keep it red).
 */
describe("H1: turning notifications off survives a relaunch", () => {
  test("off is PERSISTED, so a new manager registers nothing (mutation: drop the toggle write → red)", async () => {
    const store = fakeStore();
    const toggle = fakeToggle();
    const first = createPushManager({ toggle, store, platform: platform(), now: () => 1 });
    const client = fakeClient();
    await first.sync("c1", () => client);
    await first.setEnabledForAll([{ id: "c1" }], false, () => () => client);
    expect(toggle.stored()).toBe(false);

    // A relaunch: a fresh manager AND a fresh registrar over the same Keychain.
    const calls: string[] = [];
    const spying: PushClient = {
      pushRegister: async () => {
        calls.push("register");
        return { push: "on", graceSeconds: 30 };
      },
      pushUnregister: async () => {
        calls.push("unregister");
      },
    };
    const relaunched = createPushManager({ toggle, store, platform: platform(), now: () => 2 });
    await relaunched.ready();
    // The row says off BEFORE any link comes up — the first frame a relaunch shows.
    expect(relaunched.viewForAll([{ id: "c1", name: "Mac" }], "granted").enabled).toBe(false);
    await relaunched.sync("c1", () => spying);
    expect(calls).toEqual([]);
  });

  test("a stored OFF is the registrar's start state, not just the row's", async () => {
    const manager = createPushManager({
      toggle: fakeToggle(false),
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.ready();
    const client = fakeClient();
    await manager.sync("c1", () => client);
    expect(client.registers).toEqual([]);
    expect(manager.stateOf("c1")?.enabled).toBe(false);
  });
});

describe("H2: off with no link is a DEBT, drained on the next connect", () => {
  test("no connection → the unregister is sent on the next sync, before anything else (mutation: `await link()?.…` → red)", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const calls: string[] = [];
    const live: PushClient = {
      pushRegister: async () => {
        calls.push("register");
        return { push: "on", graceSeconds: 30 };
      },
      pushUnregister: async () => {
        calls.push("unregister");
      },
    };
    await manager.sync("c1", () => live);
    // The computer is not connected: `CLIENTS.get(id)` is undefined.
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => undefined);
    expect(calls).toEqual(["register"]);
    // The link comes back: the debt is settled, and the toggle is off, so the
    // registration is NOT renewed.
    await manager.sync("c1", () => live);
    expect(calls).toEqual(["register", "unregister"]);
    // And it is settled exactly once.
    await manager.sync("c1", () => live);
    expect(calls).toEqual(["register", "unregister"]);
    expect(store.items.get("c1")).toBeUndefined();
  });

  test("a FAILED unregister is a debt too (the error is not swallowed as success)", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    await manager.sync("c1", () => fakeClient());
    const broken: PushClient = {
      pushRegister: async () => ({ push: "on", graceSeconds: 30 }),
      pushUnregister: async () => {
        throw new Error("connection closed");
      },
    };
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => broken);
    // Still owed: the record says so instead of being forgotten.
    expect(store.items.get("c1")?.off).toBe(true);
    let sent = 0;
    await manager.sync("c1", () => ({
      pushRegister: async () => ({ push: "on", graceSeconds: 30 }),
      pushUnregister: async () => {
        sent += 1;
      },
    }));
    expect(sent).toBe(1);
    expect(store.items.get("c1")).toBeUndefined();
  });

  test("a link that is GONE at drain time keeps the debt (it is not cleared un-sent)", async () => {
    // The narrow case `toggleSink` cannot protect: `sync` hands the registrar a
    // live sink wrapper over a link that has ALREADY gone away, so the debt path
    // calls `unregister()` on nothing. `linkPushSink` must throw there, or the
    // debt is silently cleared and the daemon keeps pushing (mutation:
    // `await link()?.pushUnregister()` → red).
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    await manager.sync("c1", () => fakeClient());
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => undefined);
    expect(store.items.get("c1")?.off).toBe(true);
    // The connect happens but the client is gone by the time it runs.
    await manager.sync("c1", () => undefined);
    expect(store.items.get("c1")?.off).toBe(true);
    // The next connect that really has a client settles it.
    let sent = 0;
    await manager.sync("c1", () => ({
      pushRegister: async () => ({ push: "on", graceSeconds: 30 }),
      pushUnregister: async () => {
        sent += 1;
      },
    }));
    expect(sent).toBe(1);
    expect(store.items.get("c1")).toBeUndefined();
  });

  test("a debt left while ON does not suppress the registration turn-on asks for", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    await manager.sync("c1", () => fakeClient());
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => undefined);
    await manager.setEnabledForAll([{ id: "c1" }], true, () => () => undefined);
    const calls: string[] = [];
    await manager.sync("c1", () => ({
      pushRegister: async () => {
        calls.push("register");
        return { push: "on", graceSeconds: 30 };
      },
      pushUnregister: async () => {
        calls.push("unregister");
      },
    }));
    expect(calls).toEqual(["unregister", "register"]);
  });
});

describe("H3: turning it back on registers without waiting for a reconnect", () => {
  test("the ON toggle syncs with the live link (mutation: only set `unknown` → red)", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    const calls: string[] = [];
    const live: PushClient = {
      pushRegister: async () => {
        calls.push("register");
        return { push: "on", graceSeconds: 30 };
      },
      pushUnregister: async () => {
        calls.push("unregister");
      },
    };
    await manager.sync("c1", () => live);
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => live);
    await manager.setEnabledForAll([{ id: "c1" }], true, () => () => live);
    expect(calls).toEqual(["register", "unregister", "register"]);
    // The row tells the daemon's real answer, not "Not checked yet".
    expect(manager.viewForAll([{ id: "c1", name: "Mac" }], "granted").detail).toContain("On");
  });

  test("with no link it stays `unknown` for the next connect, not `failed`", async () => {
    const store = fakeStore();
    const manager = createPushManager({
      toggle: fakeToggle(),
      store,
      platform: platform(),
      now: () => 1,
    });
    await manager.sync("c1", () => fakeClient());
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => undefined);
    await manager.setEnabledForAll([{ id: "c1" }], true, () => () => undefined);
    // A disconnected computer must not outrank one that IS on in the one row.
    expect(manager.stateOf("c1")?.phase).toBe("unknown");
  });
});

describe("H4: one old daemon does not lock the phone's switch", () => {
  const old: PushClient = {
    pushRegister: async () => {
      throw Object.assign(new Error("MethodNotFound"), { code: -32601 });
    },
    pushUnregister: async () => {},
  };

  test("the phone-wide row stays switchable so the other computers can be turned off", async () => {
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.sync("new", () => fakeClient());
    await manager.sync("old", () => old);
    const view = manager.viewForAll(
      [
        { id: "new", name: "Mac A" },
        { id: "old", name: "Mac B" },
      ],
      "granted",
    );
    // The copy still says which computer has to be updated…
    expect(view.detail).toContain("Update tentacle on Mac B");
    expect(view.enabled).toBe(true);
    // …but the switch works: the person must be able to stop notifications for
    // the computer that DOES deliver (mutation: reuse notificationsView's
    // one-computer `switchable` → red).
    expect(view.switchable).toBe(true);
  });

  test("the OS's own refusal still disables it (that is the one thing the app cannot flip)", () => {
    const manager = createPushManager({
      toggle: fakeToggle(),
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    for (const permission of ["denied", "unavailable"] as const) {
      expect(manager.viewForAll([{ id: "c1", name: "Mac" }], permission).switchable).toBe(false);
    }
  });

  test("a single computer's row keeps the one-computer rule (`notificationsView` is unchanged)", () => {
    // The fix is scoped to the PHONE-wide row: with one computer the two views
    // agree, so this is a positive control, not a second rule.
    expect(
      notificationsView({ enabled: true, phase: "daemon-too-old" }, "Mac", "granted").switchable,
    ).toBe(false);
  });
});

/**
 * Review round 2 (§9: each of these was RED on the reviewed code — see Execution
 * "Fix round 2" for the runs, and the mutation that must keep it red).
 *
 * R2-1's own red is in `computer-store.test.ts` (the store was dropping the
 * debt) AND here, over the REAL store: the reviewer's point was that every
 * earlier H2 test used a fake memory that stored the object verbatim, so the
 * app's own path was never exercised.
 */
describe("R2-1: the debt survives the REAL Keychain store, end to end", () => {
  /** A real `createComputerStore` over an in-memory Keychain. */
  function realStore() {
    const items = new Map<string, string>();
    const kv = {
      get: async (key: string) => items.get(key) ?? null,
      set: async (key: string, value: string) => {
        items.set(key, value);
      },
      delete: async (key: string) => {
        items.delete(key);
      },
    };
    return { kv, store: createComputerStore({ kv, keychainAccessible: 1 }) };
  }

  const paired = async (): Promise<ReturnType<typeof realStore>> => {
    const made = realStore();
    await made.store.add(
      {
        id: "c1",
        name: "Mac",
        computerKey: "c".repeat(43),
        addresses: ["ws://127.0.0.1:4000/e2e"],
        deviceName: "iPhone",
        pairedAt: 1,
      },
      "d".repeat(43),
    );
    return made;
  };

  test("off with no link → the NEXT manager unregisters (mutation: drop `off` in pushRegistrationOf → red)", async () => {
    const { store } = await paired();
    const toggle = fakeToggle();
    const calls: string[] = [];
    const live: PushClient = {
      pushRegister: async () => {
        calls.push("register");
        return { push: "on", graceSeconds: 30 };
      },
      pushUnregister: async () => {
        calls.push("unregister");
      },
    };
    const first = createPushManager({ store, toggle, platform: platform(), now: () => 1 });
    await first.sync("c1", () => live);
    // The computer is not connected (the app's `CLIENTS.get(id)` is undefined).
    await first.setEnabledForAll([{ id: "c1" }], false, () => () => undefined);
    expect(calls).toEqual(["register"]);
    // What the store really hands back: the debt, not just a bare fingerprint.
    expect((await store.get("c1"))?.push).toEqual({ hash: "", registeredAt: 1, off: true });

    // A RELAUNCH: a new manager, the same Keychain, a live link again.
    const second = createPushManager({ store, toggle, platform: platform(), now: () => 1 });
    await second.sync("c1", () => live);
    expect(calls).toEqual(["register", "unregister"]);
    // Settled, and not re-registered: the toggle is off.
    expect((await store.get("c1"))?.push).toBeUndefined();
  });

  test("…and turning it back on then registers in that SAME connect", async () => {
    const { store } = await paired();
    const toggle = fakeToggle();
    const calls: string[] = [];
    const live: PushClient = {
      pushRegister: async () => {
        calls.push("register");
        return { push: "on", graceSeconds: 30 };
      },
      pushUnregister: async () => {
        calls.push("unregister");
      },
    };
    const first = createPushManager({ store, toggle, platform: platform(), now: () => 1 });
    await first.sync("c1", () => live);
    await first.setEnabledForAll([{ id: "c1" }], false, () => () => undefined);

    // Back ON while the computer is still away, then the link comes up.
    const second = createPushManager({ store, toggle, platform: platform(), now: () => 1 });
    await second.setEnabledForAll([{ id: "c1" }], true, () => () => undefined);
    await second.sync("c1", () => live);
    // The daemon's stale file is dropped first, then the person's new decision.
    expect(calls).toEqual(["register", "unregister", "register"]);
  });
});

describe("R2-2: a stored switch this build cannot read is never overwritten", () => {
  test("an UNWRITABLE record is not written over (mutation: always `await toggle.write` → red)", async () => {
    const toggle = fakeToggle(false, true);
    const manager = createPushManager({
      toggle,
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.setEnabledForAll([{ id: "c1" }], true, () => () => fakeClient());
    // The decision is the session's (the row reflects it)…
    expect(manager.viewForAll([{ id: "c1", name: "Mac" }], "granted").enabled).toBe(true);
    // …and the newer build's record is untouched: no write at all.
    expect(toggle.writes()).toBe(0);
    expect(toggle.stored()).toBe(false);
  });

  test("a READABLE record still persists (the gate is the record's, not a blanket skip)", async () => {
    const toggle = fakeToggle(true);
    const manager = createPushManager({
      toggle,
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => fakeClient());
    expect(toggle.writes()).toBe(1);
    expect(toggle.stored()).toBe(false);
  });

  test("the single-computer toggle honours it too", async () => {
    const toggle = fakeToggle(false, true);
    const manager = createPushManager({
      toggle,
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.setEnabled("c1", true, () => fakeClient());
    expect(toggle.writes()).toBe(0);
  });

  test("a read that THROWS is not a licence to write (the fail-safe default, mutation: start `writable` at true → red)", async () => {
    // `push-toggle-store.ts` promises its read never rejects, but the port allows
    // it: an unreadable Keychain must not become an overwritable record.
    let writes = 0;
    const manager = createPushManager({
      toggle: {
        read: async () => {
          throw new Error("keychain locked");
        },
        write: async () => {
          writes += 1;
        },
      },
      store: fakeStore(),
      platform: platform(),
      now: () => 1,
    });
    await manager.setEnabledForAll([{ id: "c1" }], false, () => () => fakeClient());
    expect(writes).toBe(0);
  });
});
