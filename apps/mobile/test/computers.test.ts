/**
 * The computer source (docs/feat/mobile-pairing-screen.md 11b.1, Files 3): the
 * Keychain store behind 11a's `ComputerSource` seam, and NOTHING from 11a's dev
 * source left in it — no env URL, no build-time token, no `ComputerConfigError`
 * (F-H4 pins that).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  type ComputerStore,
  type PairedComputer,
  createComputerStore,
} from "../src/computer-store.ts";
import type { SecureKV } from "../src/computer-store.ts";
import { computerSource } from "../src/computers.ts";

function memoryKV(): SecureKV {
  const items = new Map<string, string>();
  return {
    async get(key) {
      return items.get(key) ?? null;
    },
    async set(key, value) {
      items.set(key, value);
    },
    async delete(key) {
      items.delete(key);
    },
  };
}

const computer: PairedComputer = {
  id: "0123456789abcdef",
  name: "MacBook",
  computerKey: "k".repeat(43),
  addresses: ["ws://127.0.0.1:4000/e2e"],
  deviceName: "iPhone",
  pairedAt: 1,
};

describe("computerSource", () => {
  let store: ComputerStore;
  beforeEach(() => {
    store = createComputerStore({ kv: memoryKV(), keychainAccessible: 1 });
  });

  test("it IS the store: add → list → get → remove", async () => {
    const source = computerSource(store);
    expect(await source.list()).toEqual([]);
    await source.add(computer, "priv");
    expect((await source.list()).map((entry) => entry.state)).toEqual(["paired"]);
    expect((await source.get(computer.id))?.deviceKey).toBe("priv");
    await source.remove(computer.id);
    expect(await source.list()).toEqual([]);
    expect(await source.get(computer.id)).toBeUndefined();
  });

  test("the record carries no token (a device key authenticates; F-H4)", () => {
    // The type, not a runtime check: a `token` field would have to be added to
    // `PairedComputer`, which the guard test in pairing-guards.test.ts forbids.
    const fields = Object.keys(computer).sort();
    expect(fields).toEqual(["addresses", "computerKey", "deviceName", "id", "name", "pairedAt"]);
  });
});
