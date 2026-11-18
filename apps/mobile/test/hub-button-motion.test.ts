/**
 * The floating hub button's animation plans (docs/feat/mobile-hub-native-driver.md):
 * every one runs on the native driver, so a JS thread busy with a streaming turn
 * cannot stutter them, and each keeps the timing it had on the JS driver.
 */
import { describe, expect, test } from "bun:test";
import { dropPlan, fadePlan, glowPlan, levelPlan } from "../src/hub-button-motion.ts";

describe("fadePlan: the show/hide fade (150 ms, native)", () => {
  test("in and out take the fade, on the native driver", () => {
    expect(fadePlan(true, false)).toEqual({ toValue: 1, duration: 150, useNativeDriver: true });
    expect(fadePlan(false, false)).toEqual({ toValue: 0, duration: 150, useNativeDriver: true });
  });
  test("Reduce Motion keeps the fade (it is not motion)", () => {
    expect(fadePlan(true, true)).toEqual({ toValue: 1, duration: 150, useNativeDriver: true });
  });
});

describe("levelPlan: the body's rest level (hub-opacity.ts)", () => {
  test("up to solid is instant: feedback at once", () => {
    expect(levelPlan(1, false)).toEqual({ toValue: 1, duration: 0, useNativeDriver: true });
  });
  test("back down to the setting takes the fade", () => {
    expect(levelPlan(0.3, false)).toEqual({ toValue: 0.3, duration: 150, useNativeDriver: true });
    expect(levelPlan(0.99, true)).toEqual({ toValue: 0.99, duration: 150, useNativeDriver: true });
  });
});

describe("dropPlan: where a dropped button goes (F23)", () => {
  test("motion on: a native spring to the snapped spot", () => {
    expect(dropPlan({ x: 10, y: 20 }, false)).toEqual({
      kind: "spring",
      spring: { toValue: { x: 10, y: 20 }, useNativeDriver: true },
    });
  });
  test("Reduce Motion: placed at once, then faded in from 0 (native)", () => {
    expect(dropPlan({ x: 10, y: 20 }, true)).toEqual({
      kind: "place",
      at: { x: 10, y: 20 },
      fadeFrom: 0,
      fade: { toValue: 1, duration: 150, useNativeDriver: true },
    });
  });
});

describe("glowPlan: the one-shot pulse of news arriving (mobile-hub-badges Design 5)", () => {
  test("it peaks then fades back to nothing, on the native driver", () => {
    const plan = glowPlan(false);
    expect(plan.fade).toEqual([
      { toValue: 0.9, duration: 220 },
      { toValue: 0, duration: 480 },
    ]);
    expect(plan.native).toBe(true);
    expect(plan.scale).toBeGreaterThan(1);
  });

  test("Reduce Motion keeps the fade and drops the scale (no growth, same news)", () => {
    expect(glowPlan(true).scale).toBe(1);
    expect(glowPlan(true).fade).toEqual(glowPlan(false).fade);
  });
});
