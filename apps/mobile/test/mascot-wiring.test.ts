/**
 * The wiring of Polpetto's scene layer into the empty session
 * (docs/feat/mobile-mascot-scenes.md). `SessionScreen.tsx` and `MascotScene.tsx`
 * are `.tsx` files Bun cannot import — React Native's sources are Flow — so the
 * wiring is pinned from the SOURCE, like `icon-glass-wiring.test.ts` and
 * `scan-session-wiring.test.ts`. The behaviour it pins:
 *
 *  - the layer exists, with `testID="mascot"`, and is clipped and transparent to
 *    touches (a layer that ate taps would break the composer under it);
 *  - it is drawn only on an EMPTY, OPEN session, so the first row removes it
 *    (owner decision 5) and Reduce Motion is the caller's flag (owner decision 6);
 *  - `transcript-empty` survives for the e2e flows, and the old words are gone
 *    (owner decision 1);
 *  - nothing new is a native dependency, and the phone still never imports the TUI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const read = (...p: string[]): string => readFileSync(join(APP, ...p), "utf8");

const screen = read("src", "screens", "SessionScreen.tsx");
const layer = read("src", "ui", "MascotScene.tsx");
const module = read("src", "mascot-scenes.ts");
const pkg = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** `screen` without its comments, so a doc comment cannot satisfy an assertion. */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

describe("the layer is in the empty session, and clipped between header and composer", () => {
  test("the screen renders `MascotSceneLayer` inside the measured band", () => {
    expect(code(screen)).toMatch(/<MascotSceneLayer[\s\S]*?geometry=\{band \?\?/);
    expect(code(screen)).toMatch(/reduceMotion=\{a11yFlags\.reduceMotion\}/);
    expect(code(screen)).toMatch(/eyeFade=\{palette\.label\}/);
  });

  test("it is drawn OVER the transcript, not behind it", () => {
    // The empty transcript is transparent, so a layer placed before it would be
    // painted UNDER nothing and simply not show. Order is the z-order.
    const list = code(screen).indexOf('testID="transcript"');
    const layerAt = code(screen).indexOf("<MascotSceneLayer");
    expect(list).toBeGreaterThan(0);
    expect(layerAt).toBeGreaterThan(list);
  });

  test("it is drawn on an empty, open session only (owner decisions 4 and 5)", () => {
    expect(code(screen)).toMatch(
      /showsScene\(\{ phase: rowsSlice\.status\.phase, rowCount: data\.length \}\)/,
    );
    // And never while the opening landing is still scrolling into place.
    expect(code(screen)).toMatch(/showsScene\([\s\S]{0,120}&& !settling/);
  });

  test("the layer is a touch-transparent, clipped, absolutely positioned box", () => {
    expect(code(layer)).toMatch(/testID="mascot"/);
    expect(code(layer)).toMatch(/pointerEvents="none"/);
    expect(code(layer)).toMatch(/overflow: "hidden"/);
    expect(code(layer)).toMatch(/position: "absolute"/);
    // Decorative: VoiceOver must not stop on it.
    expect(code(layer)).toMatch(/accessibilityElementsHidden/);
  });

  test("the clock is requestAnimationFrame, stopped on unmount", () => {
    expect(code(layer)).toMatch(/requestAnimationFrame/);
    expect(code(layer)).toMatch(/cancelAnimationFrame/);
    // The scene is drawn ONCE per mount, not per render (owner decision 4).
    expect(code(layer)).toMatch(/useState<MascotDraw>\(\(\) =>/);
  });

  test("the drawn run reaches the frame, so a scene can alternate (owner decision 2)", () => {
    // The Review's finding: the layer passed a literal `run = 0`, so Paracadute
    // always walked off the same side and Mimetismo's switches never moved.
    expect(code(layer)).toMatch(/drawOnce\(memory\)/);
    expect(code(layer)).toMatch(/frameAt\(scene, elapsed, drawn\.run,/);
    // The THIRD argument is the run; the second may be `0` (the first picture).
    expect(code(layer)).not.toMatch(/frameAt\(\s*\w+,\s*\w+,\s*0\s*[,)]/);
  });
  test("every rect gets the pure module's key, and none is made up here (Review round 2)", () => {
    // The layer keys `<Rect>` from `rectKey`, which puts the index in the key: two
    // stacked translucent puffs are two rects at one place and colour. A key built
    // in the component from the rect's shape collides, and React then warns every
    // frame and may reuse the child — dropping the blend the merge keeps.
    expect(code(layer)).toMatch(/key=\{rectKey\(rect, index\)\}/);
    expect(code(layer)).toMatch(/rects\.map\(\(rect, index\) =>/);
    expect(code(layer)).toMatch(/import \{[^}]*rectKey[^}]*\} from "\.\.\/mascot-scenes\.ts"/);
    expect(code(layer)).not.toMatch(/key=\{`/);
  });
});

describe("the empty state keeps its id and loses the old words (owner decision 1)", () => {
  test("`transcript-empty` is still there for the e2e flows", () => {
    expect(code(screen)).toMatch(/testID="transcript-empty"/);
  });

  test("the `loading` state is unchanged", () => {
    expect(code(screen)).toMatch(/title="Opening the session…"/);
  });

  test("`Nothing here yet` / `Say something below.` are gone from the screen", () => {
    expect(code(screen)).not.toMatch(/Nothing here yet/);
    expect(code(screen)).not.toMatch(/Say something below\./);
  });
});

describe("no new native dependency, and still no TUI in the phone's bundle", () => {
  test("the layer draws with the `react-native-svg` the app already had", () => {
    expect(code(layer)).toMatch(/from "react-native-svg"/);
    expect(pkg.dependencies["react-native-svg"]).toBeDefined();
  });

  test("the pure module imports nothing, and the app does not depend on the TUI", () => {
    expect(
      code(module)
        .split("\n")
        .filter((line) => /^import\s/.test(line)),
    ).toEqual([]);
    expect(pkg.dependencies["@tentacle/tui"]).toBeUndefined();
    expect(pkg.devDependencies["@tentacle/tui"]).toBeUndefined();
  });
});
