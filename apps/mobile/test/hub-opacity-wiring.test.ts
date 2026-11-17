/**
 * The floating hub button's two-layer split (docs/feat/mobile-hub-opacity.md) —
 * the plan's load-bearing assumption, pinned where Bun can reach it.
 *
 * The component is `.tsx` (unimportable from Bun: React Native's sources are
 * Flow), so this pins the structure from the source, the `band-wiring.test.ts`
 * pattern. The property that makes the feature work at all: RN multiplies a
 * layer's opacity into its children, so the running-turn arc must NOT be inside
 * the layer that carries the rest opacity — otherwise the arc dims with the
 * body, and the owner's "the arc always stays solid" is lost. A unit test of
 * `hubOpacity` cannot see that; this can.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const BUTTON = read("src", "ui", "FloatingActivity.tsx");
/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");
const BODY = code(BUTTON);

/**
 * The JSX element whose opening tag contains `marker`: a real tag scan, because a
 * naive balance count is thrown off by self-closing children
 * (`<Animated.View ... />`), which are the norm in this file.
 */
function element(src: string, marker: string): { full: string; inner: string } {
  const at = src.indexOf(marker);
  if (at < 0) {
    throw new Error(`no ${marker}`);
  }
  const start = src.lastIndexOf("<", at);
  const nameEnd = start + 1 + (/^[A-Za-z.]*/.exec(src.slice(start + 1))?.[0].length ?? 0);
  const tag = src.slice(start + 1, nameEnd);
  // Where the opening tag ends, skipping quoted attribute values.
  let i = nameEnd;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === ">") {
      break;
    }
    i += 1;
  }
  const body = i + 1;
  if (src[i - 1] === "/") {
    return { full: src.slice(start, body), inner: "" };
  }
  let depth = 1;
  let j = body;
  while (j < src.length) {
    const next = src.indexOf("<", j);
    if (next < 0) {
      break;
    }
    if (src.startsWith("</", next)) {
      depth -= 1;
      const end = src.indexOf(">", next);
      if (depth === 0) {
        return { full: src.slice(start, end + 1), inner: src.slice(body, next) };
      }
      j = end + 1;
      continue;
    }
    const end = src.indexOf(">", next);
    if (end < 0) {
      break;
    }
    if (src[end - 1] !== "/") {
      depth += 1;
    }
    j = end + 1;
  }
  throw new Error(`unbalanced ${tag}`);
}

describe("the arc is outside the opacity layer (RN multiplies a parent's opacity down)", () => {
  const outer = element(BODY, 'testID="floating-activity"');
  const body = element(outer.inner, "styles.body");
  /**
   * The outer view with the body taken OUT: everything else is the shell.
   */
  const shell = outer.inner.replace(body.full, "");

  test("the rest level is on the body layer, not on the outer view", () => {
    // The outer view keeps the show/hide fade and the transform ONLY: it is the
    // box, it paints nothing.
    expect(outer.full).toContain("transform: xy.getTranslateTransform()");
    expect(shell).not.toContain("bodyLevel");
    expect(body.full).toContain("opacity: bodyLevel");
  });

  test("the arc is the body layer's SIBLING: it is not inside it", () => {
    expect(body.full).not.toContain("hub-arc");
    expect(body.full).not.toContain("hub-arc-halo");
    expect(body.full).toContain("hub-glyph");
    expect(shell).toContain("hub-arc");
  });

  test("the arc's opacity is never set: it follows the outer fade only", () => {
    expect(element(shell, 'testID="hub-arc"').full).not.toContain("opacity");
  });

  test("the shadow is on a layer that PAINTS and does NOT clip (iOS clips a layer's shadow)", () => {
    // Two iOS facts, both in RN's own source (`RCTView.m`), and each one alone
    // loses the shadow:
    //  1. a layer's shadow is clipped by the layer, so a casting view must not be
    //     `overflow: hidden` (RN sets `layer.mask` for it, `updateClippingForLayer`);
    //  2. RN computes a `shadowPath` only for a view with a SOLID background and
    //     otherwise falls back to the layer's own pixels
    //     (`RCTUpdateShadowPathForView`) — an EMPTY layer casts nothing.
    // Round 4's finding: the shadow lived on a `styles.cast` ring that painted
    // nothing and had no children, so it passed "unclipped" and still cast
    // nothing. The property is therefore "paints nothing" being FORBIDDEN here.
    expect(body.full).toContain("shadowOpacity: palette.shadowOpacity");
    // The shadow fades with the body: a faint body does not cast a full one.
    expect(body.full).toContain("opacity: bodyLevel");
    const bodyStyle = /body:\s*\{[\s\S]*?\n {2}\}/.exec(BODY)?.[0];
    expect(bodyStyle).toContain("...shadow.glass");
    // Fact 1: unclipped. `styles.clip` is the glass fill's, never the body's.
    const bodyTag = body.full.slice(0, body.full.indexOf(">"));
    expect(bodyTag).not.toContain("styles.clip");
    expect(bodyStyle).not.toContain("overflow");
    // Fact 2: the casting layer has content. Its glass fill and its glyph are
    // children; the shadow is not on a sibling ring with nothing in it.
    expect(body.inner).toContain("palette.glass");
    expect(body.inner).toContain('testID="hub-glyph"');
    // No empty shadow-casting ring is left behind anywhere.
    expect(BODY).not.toContain("styles.cast");
    // The outer box does not cast either (a full shadow under a faint body).
    expect(shell).not.toContain("shadowOpacity");
    // Nor does the clipped glass fill (its own clip would swallow it).
    expect(element(body.inner, "palette.glass").full).not.toContain("shadowOpacity");
  });

  test("the body keeps the 1 pt edge (owner Q2: at 100 % the look is unchanged)", () => {
    const bodyStyle = /body:\s*\{[\s\S]*?\n {2}\}/.exec(BODY)?.[0];
    expect(bodyStyle).toContain("borderWidth: 1");
    // The edge is painted by the component's `borderColor`, and it survives at every
    // level (the body's opacity does not remove a border).
    expect(body.full).toContain("palette.glassBorder");
  });

  test("the box, the glass and the border stay on the body, not on the outer view", () => {
    expect(shell).not.toContain("palette.glass");
    expect(shell).not.toContain("glassBorder");
    expect(body.full).toContain("palette.glassBorder");
  });

  test("the arc's width and halo come from `hubOpacity`, never from a literal in the view", () => {
    const arc = element(shell, 'testID="hub-arc"').full;
    expect(arc).toContain("borderWidth: arc.width");
    expect(arc).toContain("borderWidth: arc.width + 3");
    expect(arc).toContain("arc.halo");
    // The halo is in the page colour, so it reads as a gap around the arc.
    expect(arc).toContain("palette.page");
  });
});

describe("the body's level is the machine's state, synced on every path", () => {
  test("it is read from `driver.state()`, not inferred from an effect", () => {
    // A press emits NO effect on down (`hub-gesture.ts:108`), so an effect-only
    // sync would leave a finger-down button faint.
    expect(BODY).toContain("gesture: engaged");
    expect(BODY).toMatch(/setEngaged\(driver\.state\(\)\.kind\)/);
  });

  test("every direct call into the machine syncs it (down, release, terminate, cancel, tap-overlay)", () => {
    for (const call of ["driver.down(", "driver.up(", "driver.cancel(", "driver.tapOverlay("]) {
      const at = BODY.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      // The sync is within the same call site (the next ~120 characters).
      expect(BODY.slice(at, at + 160)).toMatch(/setEngaged\(driver\.state\(\)\.kind\)/);
    }
  });

  test("`apply` syncs at the END, after the effects (the hold timer opens the fan through it)", () => {
    const apply = BODY.slice(BODY.indexOf("const apply = "), BODY.indexOf("const applyRef"));
    const last = apply.lastIndexOf("setEngaged(driver.state().kind)");
    expect(last).toBeGreaterThan(apply.lastIndexOf("setFan("));
    expect(last).toBeGreaterThan(apply.lastIndexOf("drop(effect.delta)"));
  });

  test("the fan's open state is the component's, so a close of any path returns to the setting", () => {
    expect(BODY).toContain("fanOpen: fan !== null");
  });

  test("Reduce Transparency comes from the live flags, like Reduce Motion", () => {
    expect(BODY).toContain("reduceTransparency,");
    expect(BODY).toMatch(/addEventListener\(\s*"reduceTransparencyChanged"/);
    expect(BODY).toContain("AccessibilityInfo.isReduceTransparencyEnabled()");
  });
});

const SETTINGS = code(read("src", "screens", "SettingsScreen.tsx"));
const APP_SRC = code(read("App.tsx"));
const BAND_UI = code(read("src", "ui", "HubOpacityBand.tsx"));

describe("Settings: the band is hidden in Header mode (Owner Q1) and writes once", () => {
  test('the band renders only with `activityMode === "floating"`', () => {
    expect(SETTINGS).toMatch(/activityMode !== "floating" \? null : \(\s*<HubOpacityBand/);
  });

  test("the stored value is KEPT in Header mode (nothing is written to clear it)", () => {
    // Hidden, not disabled-and-zeroed: switching to Header must leave the
    // Keychain record alone, so switching back restores the same level.
    const band = SETTINGS.slice(
      SETTINGS.indexOf("<HubOpacityBand"),
      SETTINGS.indexOf("/>", SETTINGS.indexOf("<HubOpacityBand")),
    );
    expect(band).toContain("opacity={activityOpacity}");
    expect(band).not.toContain("onChange={undefined}");
  });

  test("a newer build's record disables the slider and says why (F22)", () => {
    expect(SETTINGS).toContain("writable={activityWritable}");
    expect(BAND_UI).toContain("accessibilityState={{ disabled: !writable }}");
    expect(BAND_UI).toMatch(/this version cannot change it/);
    // ...and a disabled slider arms no responder at all.
    expect(BAND_UI).toContain("onStartShouldSetPanResponder: () => canDrag.current");
    expect(BAND_UI).toContain("writable ? pan.panHandlers : {}");
  });

  test("the three testIDs a Maestro flow can assert", () => {
    expect(BAND_UI).toContain('testID="hub-opacity-slider"');
    expect(BAND_UI).toContain('testID="hub-opacity-value"');
    expect(BAND_UI).toContain('testID="hub-opacity-preview"');
  });

  test("ONE write per gesture: it happens on release/terminate, never on a move", () => {
    const grant = BAND_UI.slice(
      BAND_UI.indexOf("onPanResponderGrant"),
      BAND_UI.indexOf("onPanResponderRelease"),
    );
    expect(grant).not.toContain("onChange");
    expect(BAND_UI).toContain("onPanResponderRelease: () => latest.current.commit()");
    expect(BAND_UI).toContain("onPanResponderTerminate: () => latest.current.commit()");
    // ...and a gesture that ends where it started writes nothing.
    expect(BAND_UI).toContain("local !== committedValue.current");
    // The write itself is outside a state updater (StrictMode could call it twice).
    expect(BAND_UI).not.toMatch(/setDragging\(\(/);
  });

  test("the release HOLDS the local value until the record catches up (no flash back)", () => {
    // Review round 4, finding 2: `commit` used to clear `dragging` synchronously,
    // while the store publishes only after `await store.write` — so every release
    // showed the OLD stored number for the Keychain round-trip and then jumped.
    const commit = BAND_UI.slice(
      BAND_UI.indexOf("const commit = "),
      BAND_UI.indexOf("latest.current = {"),
    );
    // The released value is KEPT, and kept as the finger's own value...
    expect(commit).toContain("setDragging(local)");
    // ...and the old clear-at-release is gone (a `setDragging(null)` HERE is the bug).
    expect(commit).not.toContain("setDragging(null)");
    // The hold ends when the stored prop equals it — during render, so the frame
    // that shows the new record never shows the released value again. The rule is
    // the pure `settledReleased` (`hub-opacity.ts`, unit-tested there).
    expect(BAND_UI).toContain("const settled = settledReleased(dragging, value)");
    expect(BAND_UI).toMatch(/if \(settled !== dragging\) \{\s*setDragging\(settled\);/);
    // A VoiceOver step is authoritative: it drops a held value before it writes.
    const action = BAND_UI.slice(
      BAND_UI.indexOf("const onAccessibilityAction = "),
      BAND_UI.indexOf("return ("),
    );
    expect(action).toContain("setDragging(null)");
  });

  test("the release/terminate still makes ONE write, and only when the value moved", () => {
    const commit = BAND_UI.slice(
      BAND_UI.indexOf("const commit = "),
      BAND_UI.indexOf("latest.current = {"),
    );
    const local = commit.indexOf("const local = dragged.current");
    expect(local).toBeGreaterThan(-1);
    // Read once, before the hold is published and before the write.
    expect(commit.indexOf("dragged.current = null")).toBeGreaterThan(local);
    expect(commit.indexOf("setDragging(local)")).toBeGreaterThan(local);
    expect(commit.indexOf("latest.current.onChange(local)")).toBeGreaterThan(local);
    expect(commit).toContain("local !== committedValue.current");
    expect(BAND_UI).toContain("onPanResponderRelease: () => latest.current.commit()");
    expect(BAND_UI).toContain("onPanResponderTerminate: () => latest.current.commit()");
    // The write itself is outside a state updater (StrictMode could call it twice).
    expect(BAND_UI).not.toMatch(/setDragging\(\(/);
  });

  test("the drag reads x from the TRACK: rail, fill and thumb are pointerEvents none", () => {
    // `locationX` is measured inside the deepest view touched: a drag starting on
    // the 22 pt thumb read 0–22 and the value snapped.
    for (const layer of ["styles.rail", "styles.fill", "styles.thumb"]) {
      const tag = element(BAND_UI, layer).full;
      expect(tag).toContain('pointerEvents="none"');
    }
    expect(BAND_UI).toContain("latest.current.dragTo(event.nativeEvent.locationX)");
  });

  test("VoiceOver: an adjustable with both actions, stepping through `hub-opacity.ts`", () => {
    expect(BAND_UI).toContain('accessibilityRole="adjustable"');
    expect(BAND_UI).toMatch(
      /accessibilityActions=\{\[\{ name: "increment" \}, \{ name: "decrement" \}\]\}/,
    );
    expect(BAND_UI).toContain("stepOpacity(shown,");
  });

  test("the level and the label are the clamped setting, never a raw stored number", () => {
    expect(BAND_UI).toContain("clampOpacity(opacity ?? OPACITY_DEFAULT)");
    // A drag's x goes through the track maths (and the floor), not straight to a value.
    expect(BAND_UI).toMatch(/at: \(x: number\) => opacityAt\(x, width\.current\)/);
    expect(BAND_UI).toContain("latest.current.dragTo(event.nativeEvent.locationX)");
  });

  test("the preview mirrors the button: the arc is outside the dimmed circle", () => {
    const circle = element(BAND_UI, "styles.circle").full;
    expect(circle).toContain("opacity: shown / 100");
    expect(circle).not.toContain("previewArc");
    expect(BAND_UI).toContain("styles.previewArc");
  });
});

describe("App: one write path, spreading the current settings", () => {
  test("the opacity write spreads `current()`, so the mode and the spot survive", () => {
    const at = APP_SRC.indexOf("const selectActivityOpacity");
    expect(at).toBeGreaterThan(-1);
    const fn = APP_SRC.slice(at, at + 400);
    expect(fn).toContain("...ACTIVITY_SETTINGS.current()");
    expect(fn).toContain("opacity");
    expect(fn).toContain("ACTIVITY_SETTINGS.set(");
  });

  test("a failed write reuses the existing banner", () => {
    const fn = APP_SRC.slice(
      APP_SRC.indexOf("const selectActivityOpacity"),
      APP_SRC.indexOf("const selectActivityOpacity") + 500,
    );
    expect(fn).toContain("setActivityError(");
  });

  test("the screen gets the value and the writer, and the value is optional", () => {
    expect(APP_SRC).toContain("onActivityOpacity={selectActivityOpacity}");
    expect(APP_SRC).toMatch(/activitySettings\.opacity === undefined[\s\S]{0,80}activityOpacity/);
  });

  test("the session gives the button the setting and the live Reduce Transparency flag", () => {
    const SESSION = code(read("src", "screens", "SessionScreen.tsx"));
    const at = SESSION.indexOf("<FloatingActivity");
    const props = SESSION.slice(at, SESSION.indexOf("/>", at));
    expect(props).toContain("opacity={activitySettings.opacity}");
    expect(props).toContain("reduceTransparency={a11yFlags.reduceTransparency}");
  });
});
