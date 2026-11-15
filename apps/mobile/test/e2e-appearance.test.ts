/**
 * The `appearance` hook (mobile-ui-polish slice 6): flow 24 shoots every screen
 * in light AND dark in one walk, so it flips the simulator's appearance itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appearanceOf, hookFor } from "../e2e/hooks.ts";

describe("appearance hook", () => {
  test("it is a served hook", () => {
    expect(hookFor("/appearance")).toBe("appearance");
  });

  test("only light or dark; anything else is refused (never a silent no-op)", () => {
    expect(appearanceOf("light")).toBe("light");
    expect(appearanceOf("dark")).toBe("dark");
    expect(appearanceOf(undefined)).toBeUndefined();
    expect(appearanceOf("Dark")).toBeUndefined();
    expect(appearanceOf("")).toBeUndefined();
  });

  test("the harness runs `simctl ui <udid> appearance` (not `simctl spawn`)", () => {
    const run = readFileSync(join(import.meta.dir, "..", "e2e", "run.ts"), "utf8");
    expect(run).toMatch(/appearance: async[\s\S]{0,300}"ui",[\s\S]{0,80}"appearance"/);
  });

  const flows = join(import.meta.dir, "..", "e2e", "flows");

  test("`_shot` shoots light, flips to dark, shoots dark, and leaves it light", () => {
    const shot = readFileSync(join(flows, "_shot.yaml"), "utf8");
    const at = (needle: string): number => shot.indexOf(needle);
    expect(at("takeScreenshot: ${SHOT}-light")).toBeGreaterThan(-1);
    expect(at('NAME: "dark"')).toBeGreaterThan(at("takeScreenshot: ${SHOT}-light"));
    expect(at("takeScreenshot: ${SHOT}-dark")).toBeGreaterThan(at('NAME: "dark"'));
    expect(shot.lastIndexOf('NAME: "light"')).toBeGreaterThan(at("takeScreenshot: ${SHOT}-dark"));
  });

  test("flow 24 shoots only through `_shot`, starts light and ends light", () => {
    const flow = readFileSync(join(flows, "24-ui-shots.yaml"), "utf8");
    expect(flow).not.toContain("takeScreenshot");
    const shots = [...flow.matchAll(/SHOT: "([^"]+)"/g)].map((m) => m[1]);
    expect(shots).toContain("24-pair-keyboard");
    expect(shots).toContain("24-conversation");
    expect(new Set(shots).size).toBe(shots.length);
    expect(flow.indexOf('NAME: "light"')).toBeLessThan(flow.indexOf("launchApp"));
    expect(flow.trimEnd().endsWith('NAME: "light"')).toBe(true);
  });

  test("flow 24 asserts Continue on screen with the keyboard up, before tapping it", () => {
    const flow = readFileSync(join(flows, "24-ui-shots.yaml"), "utf8");
    const typed = flow.indexOf("- inputText: ${output.payload}");
    const seen = flow.indexOf('id: "pair-paste-submit"', typed);
    const tapped = flow.indexOf('- tapOn:\n    id: "pair-paste-submit"', typed);
    expect(typed).toBeGreaterThan(-1);
    expect(flow.slice(typed, seen)).toContain("- assertVisible:");
    expect(tapped).toBeGreaterThan(seen);
  });
});
