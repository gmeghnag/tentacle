/**
 * S1 of docs/feat/mobile-chrome.md — the header's thin glyphs (A1).
 *
 * `Icon.tsx` is a `.tsx` file Bun cannot import (React Native's sources are
 * Flow), so the wiring is pinned from the source, like
 * `icon-glass-wiring.test.ts`. The precondition the plan cites holds: `expo-symbols`'
 * `SymbolWeight` includes `ultraLight|thin|light`
 * (`node_modules/expo-symbols/build/SymbolModule.types.d.ts:81`), so the
 * narrower union in `Icon.tsx:58` was the only thing that blocked them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const icon = readFileSync(join(APP, "src", "ui", "Icon.tsx"), "utf8");

describe("S1 · `Icon` accepts the thin SF Symbol weights (A1)", () => {
  test("the weight union carries `light` and `thin`", () => {
    const union = /weight\?:\s*([^;]+);/.exec(icon)?.[1] ?? "";
    expect(union).toContain('"light"');
    expect(union).toContain('"thin"');
    // The weights already in use must not be dropped by the widening.
    for (const kept of ['"regular"', '"semibold"', '"bold"']) {
      expect(union).toContain(kept);
    }
  });

  test("the default weight is unchanged (every existing call site relies on it)", () => {
    expect(icon).toMatch(/weight = "semibold"/);
  });

  test("the header's own glyph names are declared", () => {
    // `IconName` is checked against `SFSymbol`, so a name absent here is a
    // typecheck failure at the call site rather than a blank glyph on the phone.
    for (const name of ["line.3.horizontal", "gearshape", "chevron.down"]) {
      expect(icon).toContain(`"${name}"`);
    }
  });

  test("no duplicate members in the union (a copy-paste miss is a lint no-op)", () => {
    const body = /export type IconName =([\s\S]*?);/.exec(icon)?.[1] ?? "";
    const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
});
