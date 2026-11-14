/**
 * S12's structural pin (docs/feat/app-decomposition.md): the line-editing tail
 * left `App.tsx` for the pure `keys/line-layer.ts`, and it still runs LAST in
 * the ONE `useInput` — after the 13 pure layers' effects and the mouse layer,
 * and only when both passed. Moving it earlier would let line editing see a
 * chunk a layer above meant to swallow (AGENTS §7: the precedence is one
 * ordered decision inside one handler).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = readFileSync(join(import.meta.dir, "..", "src", "App.tsx"), "utf8");

const count = (needle: string): number => APP.split(needle).length - 1;

describe("App.tsx — the line tail is one call into the pure line layer", () => {
  test("no line-editing decision is left inline", () => {
    const inline = [
      "resolveLineInput(",
      "recall(",
      "downEntersList(",
      "switch (action.kind)",
      "chips.length > 0",
    ].filter((needle) => APP.includes(needle));
    expect(inline).toEqual([]);
  });

  test("ONE useInput, and inside it: route → execute → mouse → line, in that order", () => {
    expect(count("useInput(")).toBe(1);
    const at = (needle: string): number => APP.indexOf(needle, APP.indexOf("useInput("));
    const order = [
      at("routeKey("),
      at("executeEffects(routed.effects"),
      at("mouse.handleChunk("),
      at("resolveLineEffects("),
    ];
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(count("resolveLineEffects(")).toBe(1);
  });

  test("the line tail runs only when the mouse layer passed", () => {
    const mouse = APP.indexOf("mouse.handleChunk(");
    const line = APP.indexOf("resolveLineEffects(");
    const between = APP.slice(mouse, line);
    expect(between).toContain('if (mouseStep === "consumed") {');
  });

  test("the palette wrap is `paletteStep`'s, not inline arithmetic", () => {
    expect(APP).toContain("paletteStep(");
    expect(APP.includes("% n")).toBe(false);
  });
});
