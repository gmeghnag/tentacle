/**
 * S2 of docs/feat/mobile-chrome.md — the header (A1): thin bare glyphs, no glass
 * circles, a context ring, one hairline.
 *
 * The primitives are `.tsx` (unimportable from Bun: React Native's sources are
 * Flow), so this pins the wiring from the source, like `icon-glass-wiring.test.ts`.
 * Every assertion here is about the *look contract* the mockup row D fixes:
 *  - every screen header button is `HeaderIcon` (no `BlurView`, no shadow);
 *  - `GlassButton` survives ONLY over the camera (its dark chrome);
 *  - the chat header draws `ContextRing` and no longer the flat bar;
 *  - the compact header ends in a `sepChat` hairline;
 *  - the ring needs no `react-native-svg` (Design 2: no native rebuild).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(APP, ...p), "utf8");
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };

const HEADER_ICON = read("src", "ui", "HeaderIcon.tsx");
const RING = read("src", "ui", "ContextRing.tsx");
const SCREEN_HEADER = read("src", "ui", "ScreenHeader.tsx");
const SESSION_SCREEN = read("src", "screens", "SessionScreen.tsx");

const screens = readdirSync(join(APP, "src", "screens")).filter((f) => f.endsWith(".tsx"));

/** Every screen source, by name (the header buttons live in these). */
const screenSource = (file: string) => read("src", "screens", file);

describe("S2 · one thin header button for the whole app (A1)", () => {
  test("`HeaderIcon` is a bare glyph: a 44 pt pressable, no blur, no shadow, no fill", () => {
    expect(HEADER_ICON).toMatch(/<Pressable\b/);
    expect(HEADER_ICON).toMatch(/SIZE\.touch/);
    expect(HEADER_ICON).toMatch(/<Icon\b/);
    // The whole point of A1: the circles are gone from the chrome.
    expect(HEADER_ICON).not.toMatch(/BlurView/);
    expect(HEADER_ICON).not.toMatch(/shadow\.glass/);
    expect(HEADER_ICON).not.toMatch(/borderRadius/);
  });

  test("its default weight is `light` (A1's thin glyphs, at 22 pt)", () => {
    expect(HEADER_ICON).toMatch(/weight = "light"/);
    expect(HEADER_ICON).toMatch(/size = 22/);
  });

  test("a text header button is the same seam (`Cancel` on Pair)", () => {
    expect(HEADER_ICON).toMatch(/label\?: string/);
  });

  test("no screen keeps a glass circle in its header — only the over-camera chrome", () => {
    const offenders = screens
      .filter((file) => screenSource(file).includes("<GlassButton"))
      // The camera's own dark chrome is the one intentional survivor (Design 2).
      .filter((file) => {
        const src = screenSource(file);
        const sites = src.split("<GlassButton").length - 1;
        const onDark = src.split("onDark").length - 1;
        return sites > onDark;
      });
    expect(offenders).toEqual([]);
  });

  test("the chat, Sessions, Settings, Computers and Pair headers use `HeaderIcon`", () => {
    for (const file of [
      "SessionScreen.tsx",
      "SessionsScreen.tsx",
      "SettingsScreen.tsx",
      "ComputersScreen.tsx",
      "PairScreen.tsx",
    ]) {
      expect({ file, has: screenSource(file).includes("<HeaderIcon") }).toEqual({
        file,
        has: true,
      });
    }
  });
});

describe("S2 · the context ring (A1 + F11)", () => {
  test("the chat header draws `ContextRing`, not the flat bar", () => {
    // The ring is drawn ONLY when there is a reading (never a fake 0, the old
    // bar's rule), so the guard and the draw are asserted together — a `null`
    // ring or an always-null guard both fail here.
    const guard = SESSION_SCREEN.indexOf("state.view.headerContext === null ? null : (");
    expect(guard).toBeGreaterThan(-1);
    const afterGuard = SESSION_SCREEN.slice(guard, guard + 400);
    expect(afterGuard).toContain("<ContextRing");
    expect(afterGuard).toContain("percent={state.view.headerContext.percent}");
    expect(SESSION_SCREEN).toContain('testID="session-header-context"');
    // The old 64 × 2 bar is gone, and so is its style entry.
    expect(SESSION_SCREEN).not.toMatch(/contextBar:/);
    expect(SESSION_SCREEN).not.toMatch(/session-header-context[\s\S]{0,200}height: 2/);
  });

  test("the ring is plain Views — no `react-native-svg` dependency (Design 2)", () => {
    expect(pkg.dependencies["react-native-svg"]).toBeUndefined();
    expect(RING).toMatch(/from "react-native"/);
    // No IMPORT of it (the file names it in prose to say why it is absent).
    expect(RING).not.toMatch(/from "react-native-svg"/);
    // Its geometry comes from the pure module, not from numbers in the component.
    expect(RING).toMatch(/ringHalfRotation\(/);
    expect(RING).toMatch(/ringLabel\(/);
  });

  test("the ring is tappable to Session info and says its reading (F11)", () => {
    expect(RING).toMatch(/onPress\?: \(\) => void/);
    expect(RING).toMatch(/accessibilityLabel=\{label\}/);
  });
});

describe("S2 · the compact header's hairline (A1)", () => {
  test("the compact row ends in a `sepChat` hairline; the large variant does not", () => {
    // The hairline reads the palette, not a hard-coded colour (tokens are the
    // single source, AGENTS §6).
    expect(SCREEN_HEADER).toMatch(/palette\.sepChat/);
    expect(SCREEN_HEADER).toMatch(/hairlineWidth/);
    // Applied on the compact branch only: a list screen's title scrolls under
    // its own bar, so a line there would cross the content.
    const compact = SCREEN_HEADER.slice(SCREEN_HEADER.indexOf('variant === "compact"'));
    expect(compact).toMatch(/borderBottomWidth/);
    const large = SCREEN_HEADER.slice(0, SCREEN_HEADER.indexOf('variant === "compact"'));
    expect(large).not.toMatch(/borderBottomWidth/);
  });
});
