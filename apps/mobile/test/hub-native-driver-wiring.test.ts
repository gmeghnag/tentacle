/**
 * docs/feat/mobile-hub-native-driver.md: the hub button and its fan animate on
 * the NATIVE driver, so a JS thread busy with a streaming (Thinking) turn cannot
 * make them stutter. The components are `.tsx` (unimportable from Bun: React
 * Native's sources are Flow), so this pins the wiring from the source, the
 * `hub-opacity-wiring.test.ts` pattern; the plans' values are
 * `hub-button-motion.test.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** The source with its comment lines removed: prose may name what the code must not do. */
const code = (...p: string[]) =>
  readFileSync(join(ROOT, ...p), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const BUTTON = code("src", "ui", "FloatingActivity.tsx");
const FAN = code("src", "ui", "HubFan.tsx");

/** Every `Animated.timing|spring(` call's argument text, up to its `.start(`. */
function calls(src: string): string[] {
  return [...src.matchAll(/Animated\.(timing|spring)\(([\s\S]*?)\)\s*\.start\(/g)].map(
    (m) => m[2] ?? "",
  );
}

describe("the hub button: every animation on the native driver", () => {
  test("no JS-driven animation is left", () => {
    expect(BUTTON).not.toContain("useNativeDriver: false");
  });
  test("each timing/spring takes its plan from hub-button-motion.ts (native by type)", () => {
    const found = calls(BUTTON);
    // fade, rest level, drop spring, Reduce-Motion drop fade
    expect(found.length).toBe(4);
    for (const args of found) {
      expect(args).toMatch(/fadePlan\(|levelPlan\(|plan\.spring|plan\.fade/);
    }
    expect(BUTTON).toContain("Animated.timing(opacity, fadePlan(");
    expect(BUTTON).toContain("Animated.timing(bodyLevel, levelPlan(");
    expect(BUTTON).toContain("Animated.spring(xy, plan.spring)");
    expect(BUTTON).toContain("Animated.timing(opacity, plan.fade)");
  });
  test("the running arc stays native", () => {
    expect(BUTTON).toMatch(/Animated\.timing\(spin, \{[\s\S]*?useNativeDriver: true/);
  });
  test("the position is never an Animated.event (that could not be native)", () => {
    expect(BUTTON).not.toContain("Animated.event");
  });
});

describe("the fan: open/close on the native driver", () => {
  test("every fan item's spring/fade is native", () => {
    const found = [...FAN.matchAll(/Animated\.(timing|spring)\(value, \{([\s\S]*?)\}\)/g)];
    expect(found.length).toBe(2);
    for (const m of found) {
      expect(m[2]).toContain("useNativeDriver: true");
    }
    expect(FAN).not.toContain("useNativeDriver: false");
  });
});
