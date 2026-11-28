/**
 * docs/feat/mobile-ui-fluidity-s2.md: source pins of the owned clocks' wiring —
 * the render-time and Swift halves no unit test can execute here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const MODULE = "modules/tentacle-clock";

/** A source file without its comments: a pin reads code, not prose. */
function code(path: string): string {
  return readFileSync(join(APP, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the step rows own no clock of their own", () => {
  test("StepNode.tsx: no interval, no `Date.now`, no mount-time origin", () => {
    const node = code("src/ui/StepNode.tsx");
    expect(node).toContain("export function ThinkingNode");
    expect(node).not.toContain("setInterval");
    expect(node).not.toContain("Date.now");
    expect(node).not.toMatch(/useRef\(\s*Date/);
  });

  test("ThinkingNode counts from `since`, visibly and aloud; the screen passes the tail's", () => {
    const node = code("src/ui/StepNode.tsx");
    const start = node.indexOf("export function ThinkingNode");
    const body = node.slice(start, node.indexOf("export function CompactSlotNode"));
    expect(body).toMatch(/useSince\(since, \(ms\) => thinkingA11yLabel\(ms \?\? 0\)\)/);
    expect(body).toContain("liveFrom: since");
    expect(body).toContain('clock="thinking"');
    expect(node).toMatch(/<ClockText[\s\S]{0,300}since=\{liveFrom\}[\s\S]{0,300}format=\{clock\}/);
    expect(body).toContain('clockTestID="thinking-clock"');
    expect(code("src/screens/SessionScreen.tsx")).toMatch(
      /<ThinkingNode[^>]*since: layout\.tail\.since/,
    );
  });

  test("ClockText.tsx: the native view only when the module is there, else the one sampler", () => {
    const view = code("src/ui/ClockText.tsx");
    expect(view).toContain('requireOptionalNativeModule("TentacleClock") === null');
    expect(view).toContain('requireNativeView<NativeProps>("TentacleClock")');
    expect(view).toContain("useSince(since,");
    expect(view).toContain("formatClock(format, ms)");
    expect(view).toContain("Math.min(fontScale, DENSE_FONT_SCALE)");
    expect(view).not.toContain("setInterval");
  });
});

/** SwiftPM refuses the WHOLE package when one target has no source folder. */
describe("the Swift package can load", () => {
  const PKG = "native-tests/PushCoreTests";

  test("every `.target` has its source folder", () => {
    const manifest = code(`${PKG}/Package.swift`);
    const targets = [...manifest.matchAll(/\.target\(\s*name: "(\w+)"/g)].map((m) => m[1] ?? "");
    expect(targets).toContain("PushCore");
    expect(targets.filter((name) => !existsSync(join(APP, PKG, "Sources", name)))).toEqual([]);
  });

  test("`Sources/ClockCore` is the module's own folder (one implementation, no copy)", () => {
    const link = join(APP, PKG, "Sources/ClockCore");
    expect(existsSync(link) && lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(APP, MODULE, "ios/ClockCore")));
  });
});

describe("the native clock", () => {
  test("ClockCore imports Foundation only (so `swift test` runs it on macOS)", () => {
    const core = code(`${MODULE}/ios/ClockCore/ClockCore.swift`);
    expect(core.match(/^import \w+$/gm)).toEqual(["import Foundation"]);
  });

  test("the view resizes itself, ticks during a scroll, holds no cycle, dies with its row", () => {
    const view = code(`${MODULE}/ios/ClockTextView.swift`);
    expect(view).toContain("setViewSize(");
    expect(view).toContain("RunLoop.main.add(next, forMode: .common)");
    expect(view).toContain("[weak self] _ in");
    expect(view).toContain("ClockCore.formatClock(format, max(0, nowMs - since))");
    expect(view).toMatch(/override func removeFromSuperview\(\) \{\s*stop\(\)/);
    expect(view).toMatch(/deinit \{\s*timer\?\.invalidate\(\)/);
  });

  test("the module declares every prop the JS view sends", () => {
    const module = code(`${MODULE}/ios/TentacleClockModule.swift`);
    expect(module).toContain('Name("TentacleClock")');
    expect([...module.matchAll(/Prop\("(\w+)"\)/g)].map((m) => m[1]).sort()).toEqual([
      "color",
      "fontFamily",
      "fontSize",
      "format",
      "lineHeight",
      "since",
      "tabular",
    ]);
    const config = JSON.parse(readFileSync(join(APP, MODULE, "expo-module.config.json"), "utf8"));
    expect(config.apple.modules).toEqual(["TentacleClockModule"]);
  });
});
