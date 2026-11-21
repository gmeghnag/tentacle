/**
 * `shell-rows-store.ts` (docs/feat/shell-intent-line.md §7): the `Compact shell
 * rows` Beta switch — the theme store's fail-safe rules (a broken store never
 * turns the beta ON; a newer record is never written over).
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV } from "../src/computer-store.ts";
import {
  DEFAULT_SHELL_ROWS,
  SHELL_ROWS_KEY,
  ShellRowsPreserved,
  createShellRowsHolder,
  createShellRowsStore,
} from "../src/shell-rows-store.ts";

function fake(initial: string | null = null, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(SHELL_ROWS_KEY, initial);
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
    store: createShellRowsStore({ kv, keychainAccessible: 6 }),
    items,
    writes: () => writes,
  };
}

describe("shell rows store", () => {
  test("missing → OFF; a pick reads back as a v1 record under its own key", async () => {
    expect(DEFAULT_SHELL_ROWS).toEqual({ compactShell: false });
    const f = fake();
    expect(await f.store.read()).toEqual({ settings: { compactShell: false }, writable: true });
    await f.store.write({ compactShell: true });
    expect(await f.store.read()).toEqual({ settings: { compactShell: true }, writable: true });
    expect(JSON.parse(f.items.get(SHELL_ROWS_KEY) ?? "")).toEqual({ v: 1, compactShell: true });
    expect(SHELL_ROWS_KEY).toBe("tentacle.shell-rows");
  });

  for (const [name, raw] of [
    ["not JSON", "{nope"],
    ["a newer version", '{"v":9,"compactShell":true}'],
    ["a wrong type", '{"v":1,"compactShell":"yes"}'],
    ["null", "null"],
  ] as const) {
    test(`${name} → OFF, and a write over it is refused (left untouched)`, async () => {
      const f = fake(raw);
      expect(await f.store.read()).toEqual({ settings: DEFAULT_SHELL_ROWS, writable: false });
      await expect(f.store.write({ compactShell: true })).rejects.toBeInstanceOf(
        ShellRowsPreserved,
      );
      expect(f.items.get(SHELL_ROWS_KEY)).toBe(raw);
      expect(f.writes()).toBe(0);
    });
  }

  test("an unreadable keychain → OFF and writes refused", async () => {
    const f = fake('{"v":1,"compactShell":true}', { failGet: true });
    expect(await f.store.read()).toEqual({ settings: DEFAULT_SHELL_ROWS, writable: false });
    await expect(f.store.write({ compactShell: false })).rejects.toBeInstanceOf(ShellRowsPreserved);
  });

  test("holder: a write failure keeps the pick in memory for this run", async () => {
    const f = fake(null, { failSet: true });
    const holder = createShellRowsHolder(f.store);
    await holder.load();
    const seen: boolean[] = [];
    holder.subscribe((s) => seen.push(s.compactShell));
    await expect(holder.set({ compactShell: true })).rejects.toThrow("disk full");
    expect(holder.current()).toEqual({ compactShell: true });
    expect(seen).toEqual([true]);
  });

  test("holder: a newer record → the switch still works this run, nothing written", async () => {
    const f = fake('{"v":9}');
    const holder = createShellRowsHolder(f.store);
    await holder.load();
    expect(holder.current()).toEqual({ compactShell: false });
    await expect(holder.set({ compactShell: true })).rejects.toBeInstanceOf(ShellRowsPreserved);
    expect(holder.current()).toEqual({ compactShell: true });
    expect(f.items.get(SHELL_ROWS_KEY)).toBe('{"v":9}');
  });
});
