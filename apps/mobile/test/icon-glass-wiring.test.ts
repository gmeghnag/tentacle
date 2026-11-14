/**
 * Owner decision 4 (docs/feat/mobile-ui-polish.md, Slices 1–2 review finding 1):
 * icons are SF Symbols and the glass is a real blur. Both live in `.tsx` files
 * Bun cannot import (React Native's sources are Flow), so the wiring is pinned
 * from the source, like `scan-session-wiring.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(APP, ...p), "utf8");
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
const icon = read("src", "ui", "Icon.tsx");
const glass = read("src", "ui", "GlassButton.tsx");

/** The slice 1–2 surfaces: the shared primitives and the two restyled screens. */
const RESTYLED = [
  ["src", "ui", "Icon.tsx"],
  ["src", "ui", "GlassButton.tsx"],
  ["src", "ui", "ScreenHeader.tsx"],
  ["src", "screens", "ComputersScreen.tsx"],
  ["src", "screens", "PairScreen.tsx"],
] as const;

/** Pictographic / symbol code points — the "strange characters" class (B3). */
const GLYPH = /[←-⯿\u{1F000}-\u{1FAFF}]/u;

describe("icons are SF Symbols (Owner Q4)", () => {
  test("`expo-symbols` is a dependency", () => {
    expect(pkg.dependencies["expo-symbols"]).toBeDefined();
  });

  test("`Icon` renders a `SymbolView` with the SF Symbol name it was given", () => {
    expect(icon).toMatch(/import \{[^}]*\bSymbolView\b[^}]*\} from "expo-symbols"/);
    expect(icon).toMatch(/<SymbolView[\s\S]*?name=\{name\}/);
  });

  test("no restyled surface draws a Unicode glyph as an icon", () => {
    for (const parts of RESTYLED) {
      const hits = read(...parts)
        .split("\n")
        .filter((l) => !/^\s*(\/?\*|\/\/)/.test(l) && GLYPH.test(l));
      expect({ file: parts.join("/"), hits }).toEqual({ file: parts.join("/"), hits: [] });
    }
  });
});

describe("the glass is a real blur (Owner Q4)", () => {
  test("`expo-blur` is a dependency", () => {
    expect(pkg.dependencies["expo-blur"]).toBeDefined();
  });

  test("`GlassButton` puts a `BlurView` behind its content", () => {
    expect(glass).toMatch(/import \{[^}]*\bBlurView\b[^}]*\} from "expo-blur"/);
    expect(glass).toMatch(/<BlurView\b/);
  });
});
