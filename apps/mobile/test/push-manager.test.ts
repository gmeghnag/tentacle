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
import {
  type PushClient,
  type PushMemoryStore,
  type PushPlatform,
  createPushManager,
  keychainPushMemory,
  notificationsView,
} from "../src/push-manager.ts";
import type { PushFacts, PushPermission } from "../src/push-registration.ts";

const TOKEN = "a".repeat(64);
const KEY = "k".repeat(43);
const facts = (): PushFacts => ({ token: TOKEN, env: "sandbox", key: KEY });

/** A Keychain store with push items only (the rest of a record is not this test's). */
function fakeStore(): PushMemoryStore & {
  readonly items: Map<string, { hash: string; registeredAt: number }>;
} {
  const items = new Map<string, { hash: string; registeredAt: number }>();
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
    const manager = createPushManager({ store, platform: platformFake, now: () => 1 });
    const client = fakeClient();
    await manager.sync("c1", () => client);
    await manager.sync("c1", () => client);
    expect(client.registers).toEqual([facts()]);
    expect(manager.stateOf("c1")?.phase).toBe("on");
  });

  test("the fingerprint survives a NEW manager (it lives in the Keychain, not in memory)", async () => {
    const store = fakeStore();
    const first = createPushManager({ store, platform: platform(), now: () => 1 });
    const client = fakeClient();
    await first.sync("c1", () => client);
    // A relaunch: a fresh manager, the same store.
    const second = createPushManager({ store, platform: platform(), now: () => 2 });
    await second.sync("c1", () => client);
    expect(client.registers.length).toBe(1);
  });

  test("two computers do not share a registrar or a fingerprint", async () => {
    const store = fakeStore();
    const manager = createPushManager({ store, platform: platform(), now: () => 1 });
    const one = fakeClient();
    const two = fakeClient();
    await manager.sync("c1", () => one);
    await manager.sync("c2", () => two);
    await manager.sync("c1", () => one);
    expect(one.registers.length).toBe(1);
    expect(two.registers.length).toBe(1);
  });

  test("a link that went away is not an exception the caller sees (the next connect retries)", async () => {
    const manager = createPushManager({ store: fakeStore(), platform: platform(), now: () => 1 });
    await manager.sync("c1", () => undefined);
    expect(manager.stateOf("c1")?.phase).toBe("failed");
  });

  test("the toggle off asks the computer to forget this device", async () => {
    const store = fakeStore();
    const manager = createPushManager({ store, platform: platform(), now: () => 1 });
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
    const manager = createPushManager({ store: fakeStore(), platform: platformFake, now: () => 1 });
    await manager.paired("c1", true);
    await manager.paired("c1", true);
    // Once: the second call sees a permission that is no longer undetermined.
    expect(platformFake.requests()).toBe(1);
  });

  test("never asked when there is no computer stored, or the permission is already decided", async () => {
    const undetermined = platform({ permission: async () => "undetermined" });
    const manager = createPushManager({ store: fakeStore(), platform: undetermined, now: () => 1 });
    await manager.paired("c1", false);
    expect(undetermined.requests()).toBe(0);
    const decided = platform({ permission: async () => "denied" });
    const second = createPushManager({ store: fakeStore(), platform: decided, now: () => 1 });
    await second.paired("c1", true);
    expect(decided.requests()).toBe(0);
  });
});

describe("the ONE Settings row, over every paired computer", () => {
  test("no computer: the row is on by default and says nothing was checked", () => {
    const manager = createPushManager({ store: fakeStore(), platform: platform(), now: () => 1 });
    const view = manager.viewForAll([], "granted");
    expect(view.enabled).toBe(true);
    expect(view.detail).toContain("Not checked yet");
    // And not switchable: a tap with no computer to reach would do nothing.
    expect(view.switchable).toBe(false);
  });

  test("a computer that cannot deliver OUTRANKS one that can (it is why nothing arrives)", async () => {
    const store = fakeStore();
    const manager = createPushManager({ store, platform: platform(), now: () => 1 });
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
    const manager = createPushManager({ store, platform: platform(), now: () => 1 });
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
