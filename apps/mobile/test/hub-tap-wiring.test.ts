/**
 * The tap→hub wiring of docs/feat/mobile-hub-tap.md, pinned where Bun can reach
 * it. `ui/HubFan.tsx` and `ui/FloatingActivity.tsx` are `.tsx` (unimportable
 * from Bun: React Native's sources are Flow), so this pins the structure from
 * the source — the `hub-opacity-wiring.test.ts` pattern. What the machine does
 * with a tap is `hub-gesture.test.ts`'s; this is only that the screen and the
 * views hand it the right facts and draw the right thing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const BUTTON = code(read("src", "ui", "FloatingActivity.tsx"));
const FAN = code(read("src", "ui", "HubFan.tsx"));
const SCREEN = code(read("src", "screens", "SessionScreen.tsx"));

describe("the screen tells the hub whether Activity has anything to show", () => {
  test("`activityEmpty` is the sheet's OWN emptiness rule, not a second one", () => {
    const at = SCREEN.indexOf("return hubContextOf({");
    expect(at).toBeGreaterThan(-1);
    const call = SCREEN.slice(at, SCREEN.indexOf("\n    });", at));
    expect(call).toContain("activityEmpty: activityVm.nothingRunning");
    // `activityView(...)` is the one truth for "is the sheet empty" — the same
    // field the sheet draws its dimmed line from (`activity.ts`).
    expect(SCREEN).toMatch(/const activityVm = useMemo\(\s*\(\) =>\s*activityView\(/);
  });
});

describe("the button no longer opens Activity itself", () => {
  test("no `tap` effect branch is left to perform", () => {
    // The machine emits `open` for a tap (mobile-hub-tap Design 1); a leftover
    // `case "tap":` would be dead code that still called the old handler.
    expect(BUTTON).not.toContain('case "tap":');
  });

  test("Activity is reached through the fan's item, so the button has no `onPress` prop", () => {
    expect(BUTTON).not.toContain("onPress");
    // ...and the screen no longer passes one to it (the header pill keeps its own).
    // `HubPane` hands the button's gestures to the shell's actions.
    const PANE = code(read("src", "screens", "session", "HubPane.tsx"));
    const at = SCREEN.indexOf("<HubPane");
    const props = SCREEN.slice(at, SCREEN.indexOf("/>", at));
    expect(props).not.toContain("onPress=");
    expect(PANE).toContain("onCommit={(id) => actions.current.hubCommit(id)}");
    expect(SCREEN).toContain("hubCommit: commitHub,");
    expect(PANE).toContain("onMenu={() => actions.current.hubShowAll()}");
    expect(SCREEN).toContain('hubShowAll: () => setHubMenu("all"),');
  });

  test("VoiceOver's activate and long-press both open the actions menu (owner Q2 = B)", () => {
    // The hint says what the route does; a stale "Double-tap for Activity" would
    // announce an action the button no longer takes.
    expect(BUTTON).toContain("Double-tap for actions.");
    expect(BUTTON).not.toContain("Double-tap for Activity");
    // ONE handler for the accessibility actions, and no `onAccessibilityTap`
    // left pointing at a prop that no longer exists.
    expect(BUTTON).not.toContain("onAccessibilityTap");
    const handler = BUTTON.slice(
      BUTTON.indexOf("const onAccessibilityAction"),
      BUTTON.indexOf("return (", BUTTON.indexOf("const onAccessibilityAction")),
    );
    expect(handler).toContain('route.kind === "menu"');
    expect(handler).not.toContain("props.onPress");
  });
});

describe("a dimmed item keeps its slot and is drawn faint (Design 2, 5)", () => {
  test("the fan reads the flag the hub set, and never filters the item out", () => {
    expect(FAN).toContain("item.dimmed");
    // It is a style on the item that is still mapped and rendered: no `filter`
    // on `layout.items`, which would shift every later item's slot.
    expect(FAN).toMatch(/layout\.items\.map\(/);
    expect(FAN).not.toMatch(/layout\.items\.filter/);
  });

  test("faintness is a COLOUR now, not an opacity (mobile-hub-badges Q3 B)", () => {
    // The discs are opaque so the transcript cannot bleed through; an opacity
    // level here would put the glass back (`hub-fan.test.ts` pins the look,
    // `ui/HubFan.tsx` only applies it). No second opacity may override the
    // animated one either — that was review round 1's finding.
    expect(FAN).not.toContain("Animated.multiply");
    expect(FAN).not.toContain("DIMMED_OPACITY");
    expect(FAN).toContain("fanItemLook(item, lit)");
    expect(FAN).toContain("opacity,");
  });

  test("its VoiceOver label says why, and it is announced as not actionable", () => {
    // The sentence moved into the pure module when the bubble went away, so the
    // rim's meaning is testable (`hub-actions.test.ts` `itemA11yLabel`).
    expect(FAN).toContain("itemA11yLabel(item)");
    expect(FAN).toContain("accessibilityState={{ disabled: item.dimmed }}");
  });
});
