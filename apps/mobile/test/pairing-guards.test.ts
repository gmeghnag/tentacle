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

  test("only the wiring file imports the Keychain (the store stays pure)", () => {
    const importers = shippedSources().filter((path) =>
      /from "expo-secure-store"/.test(readFileSync(path, "utf8")),
    );
    expect(importers.map((path) => path.slice(APP.length + 1))).toEqual(["src/secure-kv.ts"]);
  });
});

/**
 * 11b.2's own seams, guarded the same way (a native import and a plist entry are
 * both invisible to the unit tests that would otherwise cover them).
 */
describe("the camera stays behind ONE seam, and the scheme is registered (11b.2)", () => {
  test("only the wiring file imports expo-camera (every other module stays testable)", () => {
    const importers = shippedSources().filter((path) =>
      /from "expo-camera"/.test(readFileSync(path, "utf8")),
    );
    expect(importers.map((path) => path.slice(APP.length + 1))).toEqual(["src/scanner.tsx"]);
  });

  test("the 11b.2 DECISION modules import no native module (they stay pure)", () => {
    // `deep-link.ts` and `camera-access.ts` are pure by design (AGENTS §7): a
    // `Linking`/`expo-camera`/`react-native` import there would make the branch
    // they decide untestable. (`SessionScreen.tsx` does import `Linking` for
    // `openURL` — pre-existing, and a screen, not a decision.)
    for (const name of ["src/deep-link.ts", "src/camera-access.ts", "src/pairing-flow.ts"]) {
      const source = readFileSync(join(APP, name), "utf8");
      expect({ name, native: /from "(expo-camera|react-native)"/.test(source) }).toEqual({
        name,
        native: false,
      });
    }
  });

  test("app.json registers the `tentacle` scheme and a camera purpose that names pairing", () => {
    // Owner Q6: the scheme is what makes `tentacle://pair?…` reach the app at
    // all — an unregistered scheme makes the deep link a no-op, silently.
    const config = JSON.parse(readFileSync(join(APP, "app.json"), "utf8")) as {
      expo?: {
        scheme?: unknown;
        plugins?: readonly unknown[];
      };
    };
    expect(config.expo?.scheme).toBe("tentacle");
    // Decision 10: the prompt explains what the camera is for. The string lives
    // in the expo-camera plugin, which is the entry that writes the plist key.
    const camera = (config.expo?.plugins ?? []).find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-camera",
    ) as readonly [string, { readonly cameraPermission?: string }] | undefined;
    expect(camera?.[1].cameraPermission ?? "").toContain("pairing code");
  });

  test("the camera never brings a microphone permission with it (pairing records no audio)", () => {
    const config = JSON.parse(readFileSync(join(APP, "app.json"), "utf8")) as {
      expo?: { plugins?: readonly unknown[] };
    };
    const camera = (config.expo?.plugins ?? []).find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-camera",
    ) as readonly [string, { readonly microphonePermission?: unknown }] | undefined;
    // `false` is expo-camera's "delete the key" (not "leave the default text").
    expect(camera?.[1].microphonePermission).toBe(false);
  });
});
