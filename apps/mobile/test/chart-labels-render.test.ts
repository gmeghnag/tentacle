/**
 * `feat/mobile-chart-labels` — the render half of C (a haloed label inside the
 * plot), D5 (one marker shape per series) and A (the legend ABOVE the plot, its
 * items pressable when the caller can act on a highlight).
 *
 * `ChartView` is walked directly, host components stubbed as STRING types
 * (`chart-view.test.ts`'s pattern: a function stub would be called and its
 * result dropped, and every assertion would pass on nothing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Fragment, isValidElement } from "react";
import { LATENCY, REVENUE } from "./chart-fixtures.ts";

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
  if (typeof type === "string" || type === undefined) {
    const node: Node = { type, props, children: [] };
    out.push(node);
    walk(props.children, node.children);
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

/** Depth-first, in drawing order: the index of a node is its place in the tree. */
const order = (nodes: readonly Node[], out: Node[] = []): Node[] => {
  for (const n of nodes) {
    out.push(n);
    order(n.children, out);
  }
  return out;
};

const all = (nodes: readonly Node[], type: string, out: Node[] = []): Node[] => {
  for (const n of nodes) {
    if (n.type === type) out.push(n);
    all(n.children, type, out);
  }
  return out;
};

let ChartView: typeof import("../src/ui/chart/ChartView.tsx").ChartView;
let full: typeof import("../src/ui/chart/ChartFullScreen.tsx");
let row: typeof import("../src/chart-row.ts");
let theme: typeof import("../src/theme.ts");

beforeAll(async () => {
  const { mock } = await import("bun:test");
  // A superset of chart-view.test.ts's stubs: Bun keeps the FIRST mock's export
  // shape for a module across files, so a missing name breaks the other file.
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
      Value: class {
        interpolate() {
          return this;
        }
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
  ChartView = (await import("../src/ui/chart/ChartView.tsx")).ChartView;
  full = await import("../src/ui/chart/ChartFullScreen.tsx");
  row = await import("../src/chart-row.ts");
  theme = await import("../src/theme.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

const viewOf = (raw: unknown, labels: "inside" | "legend" = "legend") => {
  const view = row.chartRowView(
    { name: "chart", args: JSON.stringify(raw), status: "ok" },
    { width: 358, fontScale: 1, locale: "it-IT", palette: theme.lightPalette, labels },
  );
  if (view === null) throw new Error("no view");
  return view;
};

describe("C — the inside-plot label is haloed, and the marker carries the series", () => {
  test("a haloed label is drawn as a surface-stroked copy under the readable one", () => {
    const view = viewOf(REVENUE, "inside");
    const direct = view.layout.texts.filter((t) => t.halo === true);
    expect(direct.length).toBeGreaterThan(0);
    const tree = walk(ChartView({ view, testID: "chart-h" }));
    const svgTexts = all(tree, "SvgText");
    const halos = svgTexts.filter((t) => String(t.props.testID ?? "").startsWith("halo:"));
    // One halo per inside-plot label, and its stroke is the page colour — that
    // stroke is what keeps the name readable over a fill (react-native-svg has
    // no `paint-order`, so the halo is a first copy, not a stroke on the same one).
    expect(halos).toHaveLength(direct.length);
    for (const halo of halos) {
      expect(halo.props.stroke).toBe(view.tokens.surface);
      expect(halo.props.fill).toBe(view.tokens.surface);
      expect(Number(halo.props.strokeWidth)).toBeGreaterThan(0);
    }
    // …and the readable copy sits after it, so the halo is behind.
    const index = (text: string) =>
      svgTexts.findIndex(
        (t) => t.props.children === text && !String(t.props.testID ?? "").startsWith("halo:"),
      );
    for (const t of direct) {
      const readable = index(t.text);
      expect(readable).toBeGreaterThan(0);
      expect(String(svgTexts[readable]?.props.testID ?? "")).toBe("");
      expect(svgTexts[readable - 1]?.props.stroke).toBe(view.tokens.surface);
    }
    // A guide label (no halo) is drawn once.
    const guide = view.layout.texts.filter((t) => t.halo !== true);
    expect(svgTexts.filter((t) => t.props.testID === undefined)).toHaveLength(
      view.layout.texts.length,
    );
    expect(guide.length + direct.length).toBe(view.layout.texts.length);
  });

  test("each label marker takes its series' shape (circle / square / triangle)", () => {
    const view = viewOf(LATENCY, "inside");
    const shapes = view.layout.dots.filter((d) => d.shape !== undefined).map((d) => d.shape);
    expect(shapes).toEqual(["circle", "square", "triangle"]);
    const tree = walk(ChartView({ view, testID: "chart-h" }));
    // ■ is a <Rect>, ▲ a <Path> of its own, ● a <Circle>.
    const markers = view.layout.dots.filter((d) => d.shape !== undefined);
    const square = markers.filter((d) => d.shape === "square");
    expect(square).toHaveLength(1);
    const rect = all(tree, "Rect").find(
      (r) => Number(r.props.x) === Number((square[0]?.x ?? 0) - 3.2),
    );
    expect(rect).toBeDefined();
    expect(Number(rect?.props.width)).toBeCloseTo(6.4, 5);
  });
});

describe("A — the legend above the plot", () => {
  test("it renders between the hero and the plot, never below it", () => {
    const view = viewOf(REVENUE, "legend");
    expect(view.layout.legend?.length).toBe(2);
    const tree = walk(ChartView({ view, testID: "chart-l" }));
    const flat = order(tree);
    const index = (predicate: (n: Node) => boolean) => flat.findIndex(predicate);
    const hero = index((n) => n.type === "Text" && String(n.props.testID ?? "").endsWith("-hero"));
    const legend = index((n) => n.type === "View" && n.props.testID === "chart-l-legend");
    const plot = index((n) => n.type === "View" && n.props.testID === "chart-l-plot");
    expect(hero).toBeGreaterThanOrEqual(0);
    expect(legend).toBeGreaterThan(hero);
    expect(plot).toBeGreaterThan(legend);
  });

  test("an item reads its name and last value, and carries a glyph in its series' dash", () => {
    const view = viewOf(REVENUE, "legend");
    const tree = walk(ChartView({ view, testID: "chart-l" }));
    const legend = all(tree, "View").find((n) => n.props.testID === "chart-l-legend");
    if (legend === undefined) throw new Error("no legend");
    const texts = all(legend.children, "Text").map((t) => t.props.children);
    expect(texts).toEqual(["2026", "20,8k €", "2025", "18,9k €"]);
    const glyphs = all(legend.children, "Svg");
    expect(glyphs).toHaveLength(2);
    // Series 1 is the dashed slot (markDash(1) === "6 4").
    const dashes = all(legend.children, "Line").map((l) => l.props.strokeDasharray);
    expect(dashes).toEqual([undefined, "6 4"]);
  });

  test("no handler → the items are plain views (a tile draws no button)", () => {
    const view = viewOf(REVENUE, "legend");
    const tree = walk(ChartView({ view, testID: "chart-l" }));
    const presses = all(tree, "Pressable").filter((p) =>
      String(p.props.testID ?? "").includes("-legend-"),
    );
    expect(presses).toEqual([]);
    const legend = all(tree, "View").find((n) => n.props.testID === "chart-l-legend");
    expect(
      all(legend?.children ?? [], "View").filter((v) => v.props.onPress !== undefined),
    ).toEqual([]);
  });

  test("a handler → each item is a button that reports its series; `selected` follows the highlight", () => {
    const view = viewOf(REVENUE, "legend");
    const tapped: number[] = [];
    const tree = walk(
      ChartView({
        view,
        testID: "chart-l",
        onHighlight: (k) => tapped.push(k),
        highlight: 1,
      }),
    );
    const items = all(tree, "Pressable").filter((p) =>
      String(p.props.testID ?? "").startsWith("chart-l-legend-"),
    );
    expect(items.map((i) => i.props.testID)).toEqual(["chart-l-legend-0", "chart-l-legend-1"]);
    for (const item of items) {
      expect(item.props.accessibilityRole).toBe("button");
      expect(typeof item.props.onPress).toBe("function");
    }
    expect(
      items.map((i) => (i.props.accessibilityState as { selected: boolean }).selected),
    ).toEqual([false, true]);
    for (const item of items) {
      expect(item.props.accessibilityLabel).toBe(
        item.props.testID === "chart-l-legend-0" ? "2026, 20,8k €" : "2025, 18,9k €",
      );
      (item.props.onPress as () => void)();
    }
    expect(tapped).toEqual([0, 1]);
  });

  test("a chart with no legend draws none (C, single series, bar's own legend stays absent)", () => {
    const inside = viewOf(REVENUE, "inside");
    expect(inside.layout.legend).toBeNull();
    const tree = walk(ChartView({ view: inside, testID: "chart-l" }));
    expect(all(tree, "View").find((n) => n.props.testID === "chart-l-legend")).toBeUndefined();
  });
});

describe("A in full screen — same legend, same tap", () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const view = viewOf(REVENUE, "legend");
    const tapped: number[] = [];
    const props = {
      view,
      testID: "fs",
      words: {
        chart: "Grafico",
        table: "Tabella",
        share: "Condividi",
        close: "Chiudi",
      },
      chips: [],
      kpis: [],
      mode: "chart" as const,
      scrub: null,
      reduceMotion: true,
      locale: "it-IT",
      palette: theme.lightPalette,
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
      tableHeight: 200,
      highlight: null as number | null,
      onHighlight: (k: number) => tapped.push(k),
      onClose: () => {},
      onToggle: () => {},
      onMode: () => {},
      onShare: () => {},
      ...over,
    };
    return { tree: walk(full.ChartFullScreenView(props as never)), tapped };
  };

  test("the legend sits between the hero/KPIs and the plot, and an item highlights", () => {
    const { tree, tapped } = setup();
    const flat = order(tree);
    const at = (predicate: (n: Node) => boolean) => flat.findIndex(predicate);
    const legend = at((n) => n.type === "View" && n.props.testID === "fs-legend");
    const plot = at((n) => n.type === "View" && n.props.testID === "fs-plot");
    expect(legend).toBeGreaterThanOrEqual(0);
    expect(plot).toBeGreaterThan(legend);
    const items = all(tree, "Pressable").filter((p) =>
      String(p.props.testID ?? "").startsWith("fs-legend-"),
    );
    expect(items).toHaveLength(2);
    for (const item of items) (item.props.onPress as () => void)();
    expect(tapped).toEqual([0, 1]);
  });

  test("the highlighted item reads `selected`; no other item does", () => {
    const { tree } = setup({ highlight: 0 });
    const states = all(tree, "Pressable")
      .filter((p) => String(p.props.testID ?? "").startsWith("fs-legend-"))
      .map((p) => (p.props.accessibilityState as { selected: boolean }).selected);
    expect(states).toEqual([true, false]);
  });

  test("table mode draws no legend (a table has no series to single out)", () => {
    const { tree } = setup({ mode: "table" });
    expect(all(tree, "View").find((n) => n.props.testID === "fs-legend")).toBeUndefined();
  });
});
