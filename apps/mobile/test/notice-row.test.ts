/**
 * The notice row's RENDER half (docs/feat/mobile-harness-notices.md S1): the
 * screen decides a harness line's look (`notice-group.noticeLooks`) and this row
 * only maps it to a glyph, a colour and some padding. Host stubs are STRING
 * element types (`chart-view.test.ts`'s pattern: a function stub would be called
 * and its result dropped, and every assertion would pass on nothing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fragment, isValidElement } from "react";

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

/** The one `Text` whose payload is `content`, or undefined. */
const textNode = (nodes: readonly Node[], content: string): Node | undefined =>
  all(nodes, "Text").find((node) => node.props.children === content);

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");
let theme: typeof import("../src/theme.ts");
let group: typeof import("../src/notice-group.ts");

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
  group = await import("../src/notice-group.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

/** The row tree for one notice, with the look the screen would hand it. */
function draw(
  notice: Record<string, unknown>,
  look?: { glyph: string | null; joined: boolean },
): readonly Node[] {
  const row = { kind: "notice", key: "r1", text: "a line", ...notice };
  return walk(
    transcript.TranscriptRow({
      row: row as never,
      palette: theme.lightPalette,
      onLink: () => {},
      thumbnails: {},
      ...(look === undefined ? {} : { look }),
    } as never),
  );
}

describe("a harness line is left-aligned behind a glyph column", () => {
  test("an info block's head draws `◇` in the secondary grey, its text beside it", () => {
    const nodes = draw({}, { glyph: group.NOTICE_GLYPHS.info, joined: false });
    const glyph = textNode(nodes, group.NOTICE_GLYPHS.info);
    expect(glyph).toBeDefined();
    expect(glyph?.props.style).toEqual([
      theme.typography.footnote,
      // The column is a FIXED width: a continuation's empty glyph must not shift
      // its text, so the head and the continuations share one cell.
      { width: 12, textAlign: "center" },
      { color: theme.lightPalette.sec },
    ]);
    // Left-aligned, like the TUI: no `textAlign: "center"` on a harness line.
    const body = textNode(nodes, "a line");
    expect(body?.props.style).toEqual([
      theme.typography.footnote,
      { color: theme.lightPalette.sec },
    ]);
    // The row's own testID stays the contract the Maestro flows use.
    expect(nodes[0]?.props.testID).toBe("row-r1");
  });

  test("a warning draws `▲` in amber and speaks its level", () => {
    const nodes = draw(
      { text: "the reply was cut", level: "warn" },
      { glyph: group.NOTICE_GLYPHS.warn, joined: false },
    );
    const glyph = textNode(nodes, group.NOTICE_GLYPHS.warn);
    expect(glyph).toBeDefined();
    expect((glyph?.props.style as readonly unknown[])[2]).toEqual({
      color: theme.lightPalette.orange,
    });
    // The SHAPE is the signal; VoiceOver cannot read it reliably, so the word is
    // in the label (the owner is colour-blind and a glyph is not spoken).
    expect(textNode(nodes, "the reply was cut")?.props.accessibilityLabel).toBe(
      "Warning: the reply was cut",
    );
  });

  test("a continuation keeps the column EMPTY and drops its top padding", () => {
    const joined = draw({ text: "second line" }, { glyph: null, joined: true });
    // The glyph cell EXISTS and is empty — the text hangs aligned under the head.
    expect(textNode(joined, "")).toBeDefined();
    expect((joined[0]?.props.style as readonly unknown[])[1]).toEqual({ paddingTop: 0 });
    const unjoined = draw({ text: "second line" }, { glyph: null, joined: false });
    expect((unjoined[0]?.props.style as readonly unknown[])[1]).toBeUndefined();
  });

  test("a separator stays centred and ruled, and takes no glyph", () => {
    const nodes = draw(
      { text: "compacted · ctx 1k → ~1k", separator: true },
      { glyph: null, joined: true },
    );
    expect(textNode(nodes, "compacted · ctx 1k → ~1k")?.props.style).toEqual([
      theme.typography.footnote,
      { textAlign: "center" },
      { color: theme.lightPalette.sec },
    ]);
    // Two rules around it (above and below), and no glyph text at all.
    expect(all(nodes, "View").filter((n) => n.props.style !== undefined).length).toBeGreaterThan(0);
    expect(texts(nodes)).toEqual(["compacted · ctx 1k → ~1k"]);
  });

  test("no look (a row drawn on its own) still shows its own level's glyph", () => {
    // The walk of a warn notice with NO look prop: the renderer falls back to the
    // row's `level`, so a component test or a row outside a list reads correctly.
    expect(texts(draw({ text: "cut", level: "warn" }))).toContain(group.NOTICE_GLYPHS.warn);
    expect(texts(draw({ text: "a repair" }))).toContain(group.NOTICE_GLYPHS.info);
  });
});

/**
 * The wiring pin (`tool-rows-wiring.test.ts`'s pattern): `SessionScreen` imports
 * React Native, so what it hands the row is asserted as SOURCE. Mutation: drop
 * `layout.cells` from the projection, or the prop from `TranscriptRow` → red.
 */
describe("SessionScreen hands each notice its look", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "src", "screens", "SessionScreen.tsx"),
    "utf8",
  );

  test("the looks are memoised over the rows AND the visible cells", () => {
    expect(src).toMatch(/useMemo\(\(\) => noticeLooks\(rows, layout\.cells\), \[rows, layout\]\)/);
  });

  test("renderItem passes it to a notice row only", () => {
    expect(src).toMatch(
      /item\.kind === "notice" && looks\.has\(item\.key\)[\s\S]{0,60}\{ look: looks\.get\(item\.key\) \}/,
    );
  });

  test("`looks` is in extraData, so a block's head re-renders when a neighbour arrives", () => {
    expect(src).toMatch(/rowExtraData = useMemo\([\s\S]{0,600}looks,[\s\S]{0,200}\[/);
    expect(src).toMatch(/layout,\n\s+looks,\n\s+\],/);
  });
});
