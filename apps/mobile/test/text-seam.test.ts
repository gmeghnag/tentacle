/**
 * The text seam (docs/feat/mobile-theme-beta.md): the app font reaches EVERY
 * text only if every text is `ui/Text.tsx`'s. A screen that imports `Text` or
 * `TextInput` straight from `react-native` would silently keep the system font
 * with the Figtree beta on — so no file may, except the seam itself.
 *
 * React Native's sources are Flow, so Bun cannot render a screen; the import is
 * the boundary (the `push-wiring-guards.test.ts` shape).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(import.meta.dir, "..");
const SEAM = join("src", "ui", "Text.tsx");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The names a file imports from "react-native" (every `import { … } from "react-native"`). */
function reactNativeImports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"react-native"/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (name !== undefined && name !== "") names.push(name);
    }
  }
  return names;
}

describe("every text goes through ui/Text.tsx", () => {
  const files = [join(APP, "App.tsx"), ...sources(join(APP, "src"))];

  test("no file but the seam imports Text or TextInput from react-native", () => {
    const offenders = files
      .filter((file) => relative(APP, file) !== SEAM)
      .filter((file) => {
        const names = reactNativeImports(readFileSync(file, "utf8"));
        return names.includes("Text") || names.includes("TextInput");
      })
      .map((file) => relative(APP, file));
    expect(offenders).toEqual([]);
  });

  test("the scan is not vacuous: it sees the seam's own react-native import", () => {
    expect(reactNativeImports(readFileSync(join(APP, SEAM), "utf8"))).toContain("Text");
    expect(files.length).toBeGreaterThan(50);
  });
});
