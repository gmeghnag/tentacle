/**
 * docs/feat/mobile-ui-fluidity-s7.md: nothing that moves on its own may re-render
 * the session screen or run a per-component JS timer. `.tsx` is unimportable from
 * Bun, so the wiring is pinned from the source (the `hub-native-driver-wiring`
 * pattern); the values are the pure modules' own tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** The source with its comment lines removed: prose may name what the code must not do. */
const code = (...p: string[]) =>
  readFileSync(join(ROOT, ...p), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\{?\/?\*|\/\/)/.test(line))
    .join("\n");

const SCREEN = code("src", "screens", "SessionScreen.tsx");
const PANE = code("src", "screens", "session", "SheetsPane.tsx");
const SHEET = code("src", "screens", "ActivitySheet.tsx");
const USE_SINCE = code("src", "use-since.ts");
const MASCOT = code("src", "ui", "MascotScene.tsx");
const RUN = code("src", "screens", "WorkflowRun.tsx");

const count = (src: string, needle: string): number => src.split(needle).length - 1;

describe("the Activity clock lives in the sheet's own leaf", () => {
  test("the screen runs no activity interval: the one left is the voice controller's", () => {
    expect(SCREEN).not.toContain("ACTIVITY_CLOCK_TICK_MS");
    expect(count(SCREEN, "setInterval(")).toBe(1);
    expect(SCREEN).toMatch(/const handle = setInterval\(fn, ms\);/);
  });

  test("`useWallClock` subscribes the shared sampler only while active, with no timer of its own", () => {
    expect(USE_SINCE).toMatch(
      /export function useWallClock\(active: boolean, periodMs: number\): number \{/,
    );
    const body = USE_SINCE.slice(USE_SINCE.indexOf("export function useWallClock"));
    expect(body).toContain("Math.floor(SAMPLER.now() / periodMs) * periodMs");
    expect(body).toMatch(/useSyncExternalStore\(\s*active \? SAMPLER\.subscribe : NEVER,/);
    expect(body).not.toMatch(/setInterval|setTimeout/);
  });

  test("the leaf ticks on the sheet's visibility and computes what the sheet draws", () => {
    const at = PANE.indexOf("function ActivityClockSheet(");
    expect(at).toBeGreaterThan(-1);
    const leaf = PANE.slice(at, PANE.indexOf("export const SheetsPane", at));
    expect(leaf).toContain("useWallClock(visible, ACTIVITY_CLOCK_TICK_MS)");
    expect(leaf).toMatch(/activityView\(activityInput, now\)/);
    expect(leaf).toMatch(/sheetDetail\(focus, detailInput, now\)/);
    expect(leaf).toMatch(/<ActivitySheet[\s\S]*?now=\{now\}/);
    // The visibility it ticks on is the one the sheet is shown with.
    expect(PANE).toMatch(/<ActivityClockSheet[\s\S]*?visible=\{props\.activityOpen && !yields\}/);
    // …and the sheet is mounted nowhere else.
    expect(count(PANE, "<ActivitySheet")).toBe(1);
  });

  test("the screen hands the pane the inputs, never a ticking value", () => {
    const at = SCREEN.indexOf("<SheetsPane");
    const props = SCREEN.slice(at, SCREEN.indexOf("/>", at));
    expect(props).toContain("activityInput={activityInput}");
    expect(props).toContain("detailInput={detailInput}");
    expect(props).not.toMatch(/activityVm=|activityDetail=|activityNow=|activityStamp=/);
  });

  test("the Stop arm expires by state: no clock the sheet does not read", () => {
    expect(SCREEN).toMatch(/setTimeout\(\(\) => setArm\(STOP_IDLE\), STOP_ARM_MS \+ 20\)/);
    const at = SCREEN.indexOf("const stopRow = (kind");
    const body = SCREEN.slice(at, SCREEN.indexOf("\n  };", at));
    expect(body).not.toContain("setActivityStamp(");
    // The stamp is taken once, as the sheet opens.
    expect(count(SCREEN, "setActivityStamp(Date.now())")).toBe(1);
  });
});

describe("the mascot redraws only when its picture changes", () => {
  test("a frame is stored only through `sameFrame`, never an elapsed time per rAF", () => {
    expect(MASCOT).toMatch(/setFrame\(\(\w+\) => \(sameFrame\(\w+, next\) \? \w+ : next\)\)/);
    expect(count(MASCOT, "setFrame(")).toBe(1);
    expect(MASCOT).not.toContain("setElapsedMs");
  });
});

describe("the workflow edge flows on the native driver", () => {
  test("every `Animated.timing|spring` config is native", () => {
    const configs = [...RUN.matchAll(/Animated\.(timing|spring)\([\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config).toContain("useNativeDriver: true");
    }
    expect(RUN).not.toContain("useNativeDriver: false");
  });
});

describe("the documented exception: the Activity sheet's height springs", () => {
  test("exactly two JS-driven animations, both on `height`", () => {
    expect(count(SHEET, "useNativeDriver: false")).toBe(2);
    const js = [...SHEET.matchAll(/Animated\.(?:timing|spring)\((\w+), \{[\s\S]*?\}\)/g)]
      .filter((m) => m[0].includes("useNativeDriver: false"))
      .map((m) => m[1]);
    expect(js).toEqual(["height", "height"]);
  });
});
