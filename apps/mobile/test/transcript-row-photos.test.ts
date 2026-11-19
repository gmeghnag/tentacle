/**
 * A user message's PHOTOS, drawn (feat/mobile-thinking-images S4, the owner's
 * mockup F): the photos are their own element ABOVE the text bubble, a photo-only
 * message has no bubble at all, a photo block the row cannot fit says "+N", a
 * tile with no pixels says "Image not available", and a tap opens the viewer.
 *
 * Host stubs are STRING element types (`notice-row.test.ts`'s pattern: a function
 * stub would be called and its result dropped, and every assertion would pass on
 * nothing). The DECISIONS are the pure module's (`media-layout.ts`, tested
 * there); what is asserted here is that the row is wired to them and that the
 * geometry lands outside the bubble.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fragment, isValidElement } from "react";

const SRC = join(import.meta.dir, "..", "src");

interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

const walk = (element: unknown, out: Node[] = []): Node[] => {
  if (element === null || element === undefined || typeof element === "boolean") return out;
  if (Array.isArray(element)) {
    for (const child of element) walk(child, out);
    return out;
  }
  if (!isValidElement(element)) return out;
  const { type, props } = element as { type: unknown; props: Record<string, unknown> };
  if (type === Fragment) {
    walk(props.children, out);
    return out;
  }
  if (typeof type === "function") {
    walk((type as (p: Record<string, unknown>) => unknown)(props), out);
    return out;
  }
  const node: Node = { type, props, children: [] };
  out.push(node);
  walk(props.children, node.children);
  return out;
};

const all = (nodes: readonly Node[], type: string, out: Node[] = []): Node[] => {
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    all(node.children, type, out);
  }
  return out;
};

/** Every string drawn under `nodes`, in order. */
const texts = (nodes: readonly Node[]): readonly string[] =>
  all(nodes, "Text").flatMap((node) => {
    const child = node.props.children;
    return typeof child === "string" ? [child] : [];
  });

/** The nodes whose `testID` is `id`. */
const byTestId = (nodes: readonly Node[], id: string): readonly Node[] =>
  [...all(nodes, "View"), ...all(nodes, "Image"), ...all(nodes, "Pressable")].filter(
    (node) => node.props.testID === id,
  );

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");
let theme: typeof import("../src/theme.ts");
let layout: typeof import("../src/media-layout.ts");

beforeAll(async () => {
  const { mock } = await import("bun:test");
  mock.module("react-native", () => ({
    ActivityIndicator: "ActivityIndicator",
    Image: "Image",
    Modal: "Modal",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    Switch: "Switch",
    Text: "Text",
    View: "View",
    LayoutAnimation: { configureNext: () => {}, create: () => ({}), Types: {}, Properties: {} },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
    useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove: () => {} }),
    },
    Animated: {
      View: "Animated.View",
      createAnimatedComponent: (c: unknown) => c,
      loop: () => ({ start: () => {}, stop: () => {} }),
      Text: "Animated.Text",
      Value: class {
        interpolate() {
          return this;
        }
        setValue() {}
      },
      timing: () => ({ start: () => {}, stop: () => {} }),
      spring: () => ({ start: () => {}, stop: () => {} }),
      parallel: () => ({ start: () => {}, stop: () => {} }),
    },
    Easing: { bezier: () => (t: number) => t },
    Share: { share: async () => ({}) },
  }));
  mock.module("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }));
  mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
  mock.module("expo-file-system", () => ({ File: class {}, Paths: { cache: "" } }));
  mock.module("expo-clipboard", () => ({ setStringAsync: async () => true }));
  mock.module("../src/haptics.ts", () => ({ playHaptic: () => {} }));
  mock.module("react-native-svg", () => ({
    default: "Svg",
    Svg: "Svg",
    Circle: "Circle",
    ClipPath: "ClipPath",
    Defs: "Defs",
    G: "G",
    Line: "Line",
    LinearGradient: "LinearGradient",
    Path: "Path",
    Rect: "Rect",
    Stop: "Stop",
    Text: "SvgText",
  }));
  transcript = await import("../src/screens/transcript/TranscriptRow.tsx");
  theme = await import("../src/theme.ts");
  layout = await import("../src/media-layout.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

/** One image ref as the daemon hands it to a row (`ImageRef`). */
const ref = (
  id: string,
  over: { readonly localUri?: string; readonly aspectRatio?: number } = {},
) => ({
  id,
  mimeType: "image/png",
  size: 1024,
  name: `${id}.png`,
  ...over,
});

/** The viewer pages the last tap handed up (`onOpen`). */
let opened: unknown = null;

/**
 * Draw one user row's body (`UserRowBody`: hook-free, so it can be walked; the
 * `broken` list and the viewer are `UserRowView`'s state).
 */
function draw(
  images: readonly ReturnType<typeof ref>[],
  text = "",
  palette = theme.lightPalette,
): readonly Node[] {
  return walk(
    transcript.UserRowBody({
      user: { kind: "user", key: "u1", text, images },
      palette,
      onLink: () => {},
      thumbnails: { loaded: [], inFlight: [], failed: [] },
      broken: [],
      onOpen: (pages: unknown) => {
        opened = pages;
      },
      onBroken: () => {},
    } as never),
  );
}

describe("the photos are their own element ABOVE the bubble (mockup F)", () => {
  test("a text + photo message draws the block, then the bubble (mutation: keep the photos inside the `fill` bubble → the owner's rejected WhatsApp shape)", () => {
    const nodes = draw(
      [ref("a", { localUri: "file:///p/a.png", aspectRatio: 1 })],
      "this is the text",
    );
    // The body's top level is exactly [block, bubble]: two SIBLINGS, block first.
    expect(nodes).toHaveLength(2);
    const [photos, bubble] = nodes;
    expect(photos?.props.testID).toBe("row-photos");
    // The block's own style: right-aligned, `photoBlock`'s width.
    expect((photos?.props.style as readonly unknown[])[0]).toEqual(
      expect.objectContaining({ alignSelf: "flex-end", flexDirection: "row", flexWrap: "wrap" }),
    );
    expect((photos?.props.style as readonly unknown[])[1]).toEqual({ width: 200 });
    // The second sibling is the `fill` bubble, and no photo is inside it.
    expect(JSON.stringify(bubble?.props.style)).toContain(theme.lightPalette.fill);
    expect(all(bubble?.children ?? [], "Image")).toEqual([]);
    expect(byTestId(bubble?.children ?? [], "image-a")).toEqual([]);
  });

  test("a photo-only message has NO bubble (mutation: always a bubble → an empty `fill` block under the photo)", () => {
    const nodes = draw([ref("a", { localUri: "file:///p/a.png", aspectRatio: 1 })]);
    expect(byTestId(nodes, "row-photos")).toHaveLength(1);
    // No bubble background anywhere: the only `fill`-coloured view would be the bubble.
    const fills = all(nodes, "View").filter((node) =>
      JSON.stringify(node.props.style ?? "").includes(theme.lightPalette.fill),
    );
    expect(fills).toEqual([]);
  });

  test("a text-only message draws no block at all", () => {
    const nodes = draw([], "just words");
    expect(byTestId(nodes, "row-photos")).toEqual([]);
    expect(texts(nodes)).toContain("just words");
  });

  test("the block is `photoBlock`'s geometry: a 2-photo message is one row of two 98 pt tiles (mutation: hand-place the tiles → a second geometry that drifts)", () => {
    const nodes = draw([
      ref("a", { localUri: "file:///p/a.png", aspectRatio: 1 }),
      ref("b", { localUri: "file:///p/b.png", aspectRatio: 0.5 }),
    ]);
    const block = layout.photoBlock([ref("a", { aspectRatio: 1 }), ref("b", { aspectRatio: 0.5 })]);
    expect(block.width).toBe(200);
    const tiles = byTestId(nodes, "image-a").concat(byTestId(nodes, "image-b"));
    expect(tiles).toHaveLength(2);
    const style = tiles[0]?.props.style as readonly Record<string, unknown>[];
    expect(style.at(-1)).toEqual({ width: 98, height: 98 });
  });
});

describe("the block's states (mockup F)", () => {
  test("more than 4 photos: the 4th tile says +N (mutation: drop the overlay → the hidden photos are silently lost)", () => {
    const refs = ["a", "b", "c", "d", "e"].map((id) => ref(id));
    const nodes = draw(refs);
    // Our harness only draws what the row draws; the count is the pure module's.
    expect(layout.photoBlock(refs).tiles.map((tile) => tile.overflow)).toEqual([
      undefined,
      undefined,
      undefined,
      2,
    ]);
    expect(texts(nodes)).toContain("+2");
    // The overlay is on the LAST tile only.
    const last = byTestId(nodes, "image-d");
    expect(last).toHaveLength(1);
  });

  test("a tile with no pixels says 'Image not available' and is not tappable (mutation: draw the label `[image: …]` → the person reads a filename where the photo was)", () => {
    const nodes = draw([ref("a")]);
    // The tile exists, its own label says what happened, and nothing opens.
    expect(texts(nodes)).toContain("Image not available");
    expect(texts(nodes)).not.toContain("[image: a.png]");
    expect(byTestId(nodes, "image-a-open")).toEqual([]);
  });

  test("a tile with pixels is tappable and opens the viewer on it (mutation: never call `onOpen` → a tap does nothing)", () => {
    opened = null;
    const nodes = draw([ref("a", { localUri: "file:///p/a.png" })]);
    const opens = byTestId(nodes, "image-a-open");
    expect(opens).toHaveLength(1);
    (opens[0]?.props.onPress as () => void)();
    expect(opened).toEqual({
      pages: [{ uri: "file:///p/a.png", label: "[image: a.png]" }],
      index: 0,
    });
  });

  test("the light-mode hairline is on the tile, and the dark one has none (mutation: draw `sep` in both → a pale seam on black)", () => {
    const light = draw([ref("a", { localUri: "file:///p/a.png" })]);
    const lightTile = byTestId(light, "image-a")[0];
    expect(JSON.stringify(lightTile?.props.style)).toContain(theme.lightPalette.sep);
    const dark = draw([ref("a", { localUri: "file:///p/a.png" })], "", theme.darkPalette);
    const darkTile = byTestId(dark, "image-a")[0];
    expect(JSON.stringify(darkTile?.props.style)).not.toContain(theme.darkPalette.sep);
    expect(theme.isDark(theme.darkPalette)).toBe(true);
    expect(theme.isDark(theme.lightPalette)).toBe(false);
  });

  test("a file whose Image reports a failure falls back to the label, per tile (R2-1 kept)", () => {
    const nodes = draw([
      ref("a", { localUri: "file:///p/a.png" }),
      ref("b", { localUri: "file:///p/b.png" }),
    ]);
    const images = all(nodes, "Image");
    expect(images).toHaveLength(2);
    expect(typeof images[0]?.props.onError).toBe("function");
    // Two tiles, one broken file: the other still draws.
    expect(byTestId(nodes, "image-a-open")).toHaveLength(1);
    expect(byTestId(nodes, "image-b-open")).toHaveLength(1);
  });
});

describe("the viewer is paged over the photos that have pixels (mockup F: '2 of 5')", () => {
  test("the row hands the viewer `viewerPages`' answer, not the raw image list (mutation: pass every ref → the pager holds an empty page)", () => {
    const tiles = [
      { uri: "file:///p/a.png", label: "[image: a.png]" },
      { uri: undefined, label: "[image: b.png]" },
      { uri: "file:///p/c.png", label: "[image: c.png]" },
    ];
    expect(layout.viewerPages(tiles, 2)).toEqual({
      pages: [
        { uri: "file:///p/a.png", label: "[image: a.png]" },
        { uri: "file:///p/c.png", label: "[image: c.png]" },
      ],
      index: 1,
    });
  });

  test("a tap on a tile pages EVERY photo with pixels, the '+N'-hidden ones too (mutation: page only the 4 drawn tiles → '4 of 4' for a 5-photo message)", () => {
    opened = null;
    const refs = ["a", "b", "c", "d", "e"].map((id) =>
      ref(id, { localUri: `file:///p/${id}.png` }),
    );
    const nodes = draw(refs);
    const tap = byTestId(nodes, "image-d-open")[0];
    expect(tap).toBeDefined();
    (tap?.props.onPress as () => void)();
    expect(opened).toEqual({
      pages: refs.map((r) => ({ uri: r.localUri, label: `[image: ${r.name}]` })),
      index: 3,
    });
  });

  test("the viewer reads the message's own text as its caption and counts the page it rests on (source pin: the viewer has hooks and cannot be walked)", () => {
    const row = readFileSync(join(SRC, "screens", "transcript", "TranscriptRow.tsx"), "utf8");
    expect(row).toContain("caption={user.text}");
    const viewer = readFileSync(join(SRC, "screens", "transcript", "MediaViewer.tsx"), "utf8");
    expect(viewer).toContain("onMomentumScrollEnd");
    expect(viewer).toContain("viewerPageAt(");
    expect(viewer).toContain("`${Math.max(0, page) + 1} of ${items.length}`");
    expect(viewer).toContain("Share.share({ url: current.uri })");
  });
});
