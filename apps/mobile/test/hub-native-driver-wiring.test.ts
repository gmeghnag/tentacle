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
  test("the fade takes the OUTER level, and the same level decides whether taps land (2 B)", () => {
    // docs/feat/mobile-hub-center.md D4/O5: one rule for both, from hub-scroll-dim.ts.
    expect(BUTTON).toContain("fadePlan(presence.level, reduceMotion)");
    expect(BUTTON).toMatch(/pointerEvents=\{presence\.touchable \? "auto" : "none"\}/);
  });
  test("the running arc stays native", () => {
    expect(BUTTON).toMatch(/Animated\.timing\(spin, \{[\s\S]*?useNativeDriver: true/);
  });
  test("the position is never an Animated.event (that could not be native)", () => {
    expect(BUTTON).not.toContain("Animated.event");
  });
});

describe("the fan: open/close on the native driver", () => {
  test("the fan's one animation takes its config from fanOpenPlan (native by type)", () => {
    // docs/feat/mobile-ui-fluidity-s5.md: `FanOpenPlan.timing.useNativeDriver` is
    // typed `true` (the plan's values are `hub-fan.test.ts`'s).
    const found = [
      ...FAN.matchAll(/Animated\.(timing|spring|decay|parallel|sequence|stagger|loop)\(([^)]*)\)/g),
    ].map((m) => `${m[1]}(${m[2]})`);
    expect(found).toEqual(["timing(progress, plan.timing)"]);
    expect(FAN).toContain("fanOpenPlan(motion, layout.items.length)");
    expect(FAN).not.toContain("useNativeDriver: false");
  });
});
