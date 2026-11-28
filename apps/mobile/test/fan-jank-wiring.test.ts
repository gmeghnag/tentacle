/**
 * docs/fix/mobile-fan-jank-device.md: the wiring the device fix stands on, pinned
 * from the source (the components are `.tsx`, unimportable from Bun — the
 * `hub-native-driver-wiring.test.ts` pattern). The decisions themselves are the
 * pure modules' (`render-coalesce`, `transcript-cell`, `perf-trace`, `fanMotion`).
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
const SCREEN = code("src", "screens", "SessionScreen.tsx");
const CELL_MODULE = code("src", "transcript-cell.ts");
const CELL_TSX = code("src", "screens", "transcript", "TranscriptCell.tsx");
const CONTROLLER = code("src", "session-screen-controller.ts");
const FEED = code("src", "session-feed.ts");
const APP = code("App.tsx");

describe("the fan opens once per open, whatever re-renders the screen", () => {
  test("HubFan is memoized and its opening effect is keyed on stable values only", () => {
    expect(FAN).toMatch(/export const HubFan = memo\(HubFanView\)/);
    expect(FAN).toMatch(
      /\.start\(\(\{ finished \}\) => PERF\.fanSettle\(finished\)\);\n\s*\}, \[grow, motion\]\);/,
    );
  });

  test("the button hands the fan a stable tap handler (no inline closure)", () => {
    expect(BUTTON).toMatch(/onTapOverlay=\{onTapOverlay\}/);
    expect(BUTTON).toMatch(/const onTapOverlay = useCallback\(/);
  });
});

describe("a streamed delta re-renders the screen at most once per window", () => {
  test("the feed tags text/reasoning folds as `stream`", () => {
    expect(FEED).toMatch(
      /event\.type === "text" \|\| event\.type === "reasoning" \? "stream" : undefined/,
    );
  });

  test("the controller defers a stream fold and fires everything else at once", () => {
    expect(CONTROLLER).toMatch(
      /if \(cause === "stream"\) \{\n\s*render\.soon\(\);\n\s*\} else \{\n\s*emit\(\);/,
    );
    expect(CONTROLLER).toMatch(/function emit\(\): void \{\n\s*render\.now\(\);\n\s*\}/);
    expect(CONTROLLER).toMatch(/render\.dispose\(\);/);
  });
});

describe("transcript cells are memoized", () => {
  test("renderItem draws a TranscriptCell with the ONE stable actions handle", () => {
    expect(SCREEN).toMatch(/<TranscriptCell[\s\S]*?actions=\{cellActions\}/);
    expect(SCREEN).toMatch(/const cellActions = useRef<CellActions>/);
    expect(SCREEN).not.toMatch(/<TranscriptRow\b/);
  });

  test("the cell's memo comparator is the pure one, not an inline lambda", () => {
    // `actions` is ONE ref for the screen's whole life, so a comparator that only
    // compares it never redraws a cell: a streamed row would freeze on its first
    // delta. The skip must also ask `sameCellData` — held behaviourally in
    // `transcript-cell.test.ts`; here: the component uses that ONE function
    // (Review round 1, MEDIUM 1).
    expect(CELL_TSX).toMatch(
      /export const TranscriptCell = memo\(TranscriptCellView, sameCellProps\)/,
    );
    expect(CELL_MODULE).toMatch(
      /export function sameCellProps\([\s\S]*?a\.actions === b\.actions && sameCellData\(a, b\)/,
    );
  });
});

describe("the ptrace probe is wired", () => {
  test("App attaches the ONE log; the screen reports renders, notifications, streaming", () => {
    expect(APP).toMatch(/PERF\.attach\(APP_LOG\)/);
    expect(APP).toMatch(/onStreamFold: \(\) => PERF\.fold\(\)/);
    expect(SCREEN).toMatch(/PERF\.render\(PERF\.now\(\) - renderStart\)/);
    expect(SCREEN).toMatch(/PERF\.notify\(\)/);
    expect(SCREEN).toMatch(/PERF\.streaming\(running\)/);
  });

  test("App hands every AppState change to the probe, at module scope", () => {
    expect(APP).toMatch(
      /^AppState\.addEventListener\("change", \(state\) => PERF\.appState\(state\)\);$/m,
    );
  });

  test("the hub reports the touch, the open, each start and the close", () => {
    expect(BUTTON.match(/PERF\.touch\(event\.nativeEvent\.timestamp\)/g)?.length).toBe(2);
    expect(BUTTON).toMatch(/PERF\.fanOpen\(\)/);
    expect(BUTTON).toMatch(/PERF\.fanClose\(\)/);
    expect(FAN).toMatch(/PERF\.fanStart\(\)/);
  });
});
