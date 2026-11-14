/**
 * The guards 11b.1 must not break (docs/feat/mobile-pairing-screen.md F-H4 and
 * Notes/debt): no build-time computer and no build-time token can reach a
 * shipped build, and the stored record carries no token — a device key
 * authenticates, and a token in the bundle would be a credential in the clear.
 *
 * They read the SOURCE, which is the only place a build-time value could hide
 * (Expo inlines `EXPO_PUBLIC_*` at build time, so one reference is enough).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");

/** Every `.ts`/`.tsx` the APP ships: `App.tsx`, `index.ts`, and `src/**`. */
function shippedSources(): readonly string[] {
  const files: string[] = [join(APP, "App.tsx"), join(APP, "index.ts"), join(APP, "polyfills.ts")];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
        files.push(path);
      }
    }
  };
  walk(join(APP, "src"));
  return files;
}

describe("no build-time computer, no build-time token (F-H4)", () => {
  test("no shipped source reads an EXPO_PUBLIC_TENTACLE_* variable (mutation: reinstate the dev source → red)", () => {
    const offenders = shippedSources().filter((path) =>
      /EXPO_PUBLIC_TENTACLE/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("the stored computer has no token field at all (a device key authenticates)", () => {
    const source = readFileSync(join(APP, "src", "computer-store.ts"), "utf8");
    const record = source.slice(
      source.indexOf("export interface PairedComputer"),
      source.indexOf("export interface StoredComputer"),
    );
    expect(record).not.toBe("");
    // `token` as a FIELD (the word also appears in the guards' own prose).
    expect(/\n\s{2}readonly token\??:/.test(record)).toBe(false);
    // Positive control: the record really is the block we think it is.
    expect(record).toContain("readonly computerKey: string");
    // And the key that IS there is the pinned COMPUTER key, never a device key:
    // the phone's own key lives on `StoredComputer` only.
    expect(record).not.toContain("readonly deviceKey");
  });

  test("the dev computer source and its error are gone from the app", () => {
    const all = shippedSources()
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(all).not.toContain("devComputerSource");
    expect(all).not.toContain("ComputerConfigError");
  });

  test("only the wiring files import the Keychain (every store stays pure)", () => {
    const importers = shippedSources().filter((path) =>
      /from "expo-secure-store"/.test(readFileSync(path, "utf8")),
    );
    // Two adapters, one per store: the computer store (11b.1) and the app-lock
    // setting (docs/feat/mobile-lock.md D3). Both are five-line wiring files; the
    // modules that DECIDE anything (`computer-store.ts`, `lock-settings-store.ts`)
    // stay free of the native import, which is what this guard protects.
    expect(importers.map((path) => path.slice(APP.length + 1))).toEqual([
      "src/secure-kv.ts",
      "src/lock-settings-expo.ts",
    ]);
  });
});
