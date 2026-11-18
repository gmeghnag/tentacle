/**
 * The stepped opacity slider's wiring (docs/feat/mobile-hub-defaults.md): the
 * rules are pinned in `hub-opacity.test.ts` (`snapOpacity`, `opacityAt`,
 * `opacityStepHaptic`); this pins that `HubOpacityBand.tsx` actually USES them.
 *
 * The component is `.tsx` (unimportable from Bun: React Native's sources are
 * Flow), so this reads the source, the `hub-opacity-wiring.test.ts` pattern.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BAND = readFileSync(join(import.meta.dir, "..", "src", "ui", "HubOpacityBand.tsx"), "utf8");
/** The source with its comment lines removed: prose may name what the code must not do. */
const CODE = BAND.split("\n")
  .filter((line) => !/^\s*(\/?\*|\/\/|\{\/\*)/.test(line))
  .join("\n");

/** The body of `const <name> = (...) => { ... };` — up to its first top-level `};`. */
function arrow(name: string): string {
  const at = CODE.indexOf(`const ${name} = (`);
  if (at < 0) {
    throw new Error(`no ${name} in HubOpacityBand.tsx`);
  }
  return CODE.slice(at, CODE.indexOf("\n  };", at));
}

describe("the slider is stepped, not continuous", () => {
  test("the stored value is SNAPPED (an off-step record shows as its step)", () => {
    expect(CODE).toContain("snapOpacity(opacity ?? OPACITY_DEFAULT)");
    expect(CODE).not.toContain("clampOpacity");
  });

  test("a touch maps to a step through `opacityAt` (which only returns steps)", () => {
    expect(CODE).toContain("opacityAt(x, width.current)");
  });

  test("the five steps' marks are drawn from the shared constant", () => {
    expect(CODE).toContain("OPACITY_STEPS.map(");
    expect(CODE).toContain("testID={`hub-opacity-detent-${step}`}");
  });

  test("VoiceOver reads the 20–100 range from the shared bounds", () => {
    expect(CODE).toContain("min: OPACITY_MIN, max: OPACITY_MAX");
  });
});

describe("a tick per step: the drag plays `opacityStepHaptic`", () => {
  test("every move goes through the rule, from what the slider showed before", () => {
    const dragTo = arrow("dragTo");
    expect(dragTo).toContain(
      "playHaptic(opacityStepHaptic(dragged.current ?? shownNow.current, next))",
    );
    // Compared BEFORE the live value moves on, or every move would compare a
    // step with itself and never tick.
    expect(dragTo.indexOf("opacityStepHaptic(")).toBeLessThan(
      dragTo.indexOf("dragged.current = next"),
    );
  });

  test("`shownNow` mirrors the rendered value (the grant compares against it)", () => {
    expect(CODE).toContain("shownNow.current = shown;");
  });

  test("the release writes, it does not tick (the tick already played on landing)", () => {
    expect(arrow("commit")).not.toContain("playHaptic");
  });
});
