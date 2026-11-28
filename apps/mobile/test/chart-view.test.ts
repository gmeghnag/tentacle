/**
 * T6, the render half (docs/feat/model-charts.md slice C6): `ChartView` maps
 * the pure layout to `react-native-svg` elements and nothing else. Host stubs
 * are STRING element types (see band-notes.test.ts: a function stub would be
 * called and its result dropped, and every assertion would pass on nothing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seriesColor } from "@tentacle/core";
import { Fragment, isValidElement } from "react";
import { REVENUE, spec } from "./chart-fixtures.ts";

interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

const STATEFUL = new Set(["ChartBlock", "ChartAppear", "ChartFullScreen"]);

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
  // A stateful component (hooks) cannot be called outside a renderer: it is kept
  // as a node by name, and its tree is walked from its dumb child instead (C7).
  if (typeof type === "function" && STATEFUL.has((type as { name: string }).name)) {
    out.push({ type: (type as { name: string }).name, props, children: [] });
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
  for (const n of nodes) {
    if (n.type === type) out.push(n);
    all(n.children, type, out);
  }
  return out;
};

const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flat))
    : typeof style === "object" && style !== null
      ? (style as Record<string, unknown>)
      : {};

const BARS = spec({
  type: "bar",
  title: "Token per modello",
  labels: ["Opus", "Sonnet", "Haiku"],
  datasets: [{ label: "token", data: [120, 80, 30] }],
});

let ChartView: typeof import("../src/ui/chart/ChartView.tsx").ChartView;
let full: typeof import("../src/ui/chart/ChartFullScreen.tsx");
let interact: typeof import("../src/chart-interact.ts");
let row: typeof import("../src/chart-row.ts");
let theme: typeof import("../src/theme.ts");

beforeAll(async () => {
  const { mock } = await import("bun:test");
  mock.module("react-native", () => ({
    ActivityIndicator: "ActivityIndicator",
    Image: "Image",
    Modal: "Modal",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    // A superset of band-notes.test.ts's stubs: Bun keeps the FIRST mock's export
    // shape for a module across files, so a missing name breaks the other file.
    Switch: "Switch",
    Text: "Text",
    View: "View",
    LayoutAnimation: { configureNext: () => {}, create: () => ({}), Types: {}, Properties: {} },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
    useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
    // C7 (ChartAppear / ChartFullScreen); kept in band-notes.test.ts's mock too.
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove: () => {} }),
    },
    Animated: {
      View: "Animated.View",
      createAnimatedComponent: (c: unknown) => c,
      loop: () => ({ start: () => {}, stop: () => {} }),
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
  // The text seam (docs/feat/mobile-theme-beta.md) reads the app font from a
  // context; this walker calls components without React, so it is stubbed
  // to the same host strings `react-native`'s Text/TextInput are.
  mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
  mock.module("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }));
  mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
  mock.module("expo", () => ({
    requireNativeView: () => null,
    requireOptionalNativeModule: () => null,
  }));
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
  ChartView = (await import("../src/ui/chart/ChartView.tsx")).ChartView;
  full = await import("../src/ui/chart/ChartFullScreen.tsx");
  interact = await import("../src/chart-interact.ts");
  row = await import("../src/chart-row.ts");
  theme = await import("../src/theme.ts");
  transcript = await import("../src/screens/transcript/TranscriptRow.tsx");
});

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

function render(
  raw: unknown,
  palette = theme.lightPalette,
): { tree: Node[]; view: NonNullable<ReturnType<typeof row.chartRowView>> } {
  const view = row.chartRowView(
    { name: "chart", args: JSON.stringify(raw), status: "ok" },
    { width: 358, fontScale: 1, locale: "it-IT", palette },
  );
  if (view === null) throw new Error("no view");
  return { tree: walk(ChartView({ view, testID: "chart-c1" })), view };
}

// Every group of sibling element keys under `element` (React warns on a repeat among siblings).
const siblingKeys = (element: unknown, out: string[][] = []): string[][] => {
  if (Array.isArray(element)) {
    const keys = element.flatMap((c) =>
      isValidElement(c) && c.key !== null ? [String(c.key)] : [],
    );
    if (keys.length > 0) out.push(keys);
    for (const c of element) siblingKeys(c, out);
    return out;
  }
  if (!isValidElement(element)) return out;
  const { type, props } = element as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function") {
    return siblingKeys((type as (p: Record<string, unknown>) => unknown)(props), out);
  }
  return siblingKeys(props.children, out);
};

describe("ChartView — a dumb renderer of the layout", () => {
  test("a repeated scatter point does not repeat a React key among its siblings", () => {
    const view = row.chartRowView(
      {
        name: "chart",
        args: JSON.stringify({
          type: "scatter",
          title: "Dup",
          datasets: [
            {
              label: "s",
              data: [
                { x: 1, y: 1 },
                { x: 1, y: 1 },
                { x: 2, y: 3 },
              ],
            },
          ],
        }),
        status: "ok",
      },
      { width: 358, fontScale: 1, locale: "it-IT", palette: theme.lightPalette },
    );
    if (view === null) throw new Error("no view");
    expect(view.layout.dots.length).toBe(3);
    for (const keys of siblingKeys(ChartView({ view, testID: "chart-c1" }))) {
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test("one <Path> per layout path, same `d`, in order; stroked paths are not filled", () => {
    const { tree, view } = render(REVENUE);
    const paths = all(tree, "Path");
    expect(paths.map((p) => p.props.d)).toEqual(view.layout.paths.map((p) => p.d));
    view.layout.paths.forEach((p, i) => {
      const props = paths[i]?.props ?? {};
      if (p.strokeWidth !== undefined) {
        expect(props.fill).toBe("none");
        expect(props.strokeWidth).toBe(p.strokeWidth);
      } else {
        expect(props.stroke).toBeUndefined();
      }
    });
  });

  test("a gradient path is filled from a <LinearGradient> the tree defines", () => {
    const { tree, view } = render(REVENUE);
    const asked = view.layout.paths.filter((p) => p.gradient !== undefined);
    expect(asked.length).toBeGreaterThan(0);
    const ids = all(tree, "LinearGradient").map((g) => g.props.id);
    const fills = all(tree, "Path")
      .map((p) => p.props.fill)
      .filter((f): f is string => typeof f === "string" && f.startsWith("url(#"));
    expect(fills.length).toBe(asked.length);
    for (const fill of fills) expect(ids).toContain(fill.slice(5, -1));
  });

  test("no gradient asked → none defined (bars)", () => {
    const { tree } = render(BARS);
    expect(all(tree, "LinearGradient")).toEqual([]);
    expect(all(tree, "Path").length).toBeGreaterThan(0);
  });

  test("no card: no frame, and the container has no background, radius, border or shadow", () => {
    const { tree } = render(REVENUE);
    // `feat/mobile-chart-labels` D5 draws a series marker as a <Rect> (■), so
    // "no <Rect> at all" is no longer the same claim: what a card would be is a
    // rectangle spanning the chart, and every rect here is a ~7 pt marker.
    for (const r of all(tree, "Rect")) {
      expect(Number(r.props.width)).toBeLessThanOrEqual(10);
    }
    const root = flat(tree[0]?.props.style);
    for (const key of ["backgroundColor", "borderRadius", "borderWidth", "shadowOpacity"]) {
      expect(root[key]).toBeUndefined();
    }
  });

  test("every layout text and dot is drawn; chart text is monospace", () => {
    const { tree, view } = render(REVENUE);
    // A haloed (C) label is drawn twice: the surface-coloured halo the test
    // identifies by its `halo:` testID, then the readable copy on top of it.
    const texts = all(tree, "SvgText").filter((t) => t.props.testID === undefined);
    expect(texts.map((t) => t.props.children)).toEqual(view.layout.texts.map((t) => t.text));
    for (const t of all(tree, "SvgText")) expect(t.props.fontFamily).toBe(theme.MONO);
    expect(all(tree, "Circle").length).toBeGreaterThanOrEqual(view.layout.dots.length);
  });

  test("the caption and the hero: title, then the mono hero number from `heroOf`", () => {
    const { tree, view } = render(REVENUE);
    const byId = (id: string) => all(tree, "Text").find((t) => t.props.testID === id);
    expect(byId("chart-c1-title")?.props.children).toBe("Ricavi");
    const hero = byId("chart-c1-hero");
    expect(JSON.stringify(hero?.props.children)).toContain(view.layout.hero.num);
    expect(flat(hero?.props.style).fontFamily).toBe(theme.MONO);
  });

  test("the series colours follow the mode", () => {
    const light = render(REVENUE).tree;
    const dark = render(REVENUE, theme.darkPalette).tree;
    const strokes = (t: Node[]) =>
      all(t, "Path")
        .map((p) => p.props.stroke)
        .filter(Boolean);
    expect(strokes(light)).toContain(seriesColor(0, "light"));
    expect(strokes(dark)).toContain(seriesColor(0, "dark"));
    expect(strokes(dark)).not.toContain(seriesColor(0, "light"));
  });

  test("the chart is one accessibility element read as its summary", () => {
    const { tree, view } = render(REVENUE);
    expect(tree[0]?.props.accessible).toBe(true);
    expect(tree[0]?.props.accessibilityLabel).toBe(view.layout.summary);
  });
});

describe("ChartView — C7: scrub, table, VoiceOver actions, gestures", () => {
  const viewOf = (raw: unknown) => {
    const v = row.chartRowView(
      { name: "chart", args: JSON.stringify(raw), status: "ok" },
      { width: 358, fontScale: 1, locale: "it-IT", palette: theme.lightPalette },
    );
    if (v === null) throw new Error("no view");
    return v;
  };

  test("scrubbing: the hero reads the finger's values, a rule + dots + the dim veil are drawn", () => {
    const view = viewOf(REVENUE);
    const scrub = view.layout.scrubAt(3);
    if (scrub === null) throw new Error("no scrub");
    const tree = walk(ChartView({ view, testID: "chart-c1", scrub }));
    const hero = all(tree, "Text").find((t) => t.props.testID === "chart-c1-hero");
    expect(JSON.stringify(hero?.props.children)).toContain(scrub.hero.num);
    expect(scrub.hero.num).not.toBe(view.layout.hero.num);
    const rule = all(tree, "Line").find((l) => l.props.testID === "chart-c1-rule");
    expect(rule?.props.x1).toBe(scrub.x);
    const veil = all(tree, "Rect").find((r) => r.props.testID === "chart-c1-dim");
    expect(veil?.props.x).toBe(scrub.dimFromX);
    expect(all(tree, "Circle").length).toBeGreaterThanOrEqual(
      view.layout.dots.length + scrub.dots.length,
    );
  });

  test("table mode: no plot, the table (with Δ) in its place; the summary stays the label", () => {
    const view = viewOf(REVENUE);
    const tree = walk(ChartView({ view, testID: "chart-c1", mode: "table" }));
    expect(all(tree, "Svg")).toEqual([]);
    const cells = all(tree, "Text").map((t) => t.props.children);
    expect(cells).toContain("Δ");
    expect(cells).toContain("▲ 26,8%");
    expect(tree[0]?.props.accessibilityLabel).toBe(view.layout.summary);
  });

  test("table mode: the chart's one element lets go, so the cells are focusable", () => {
    const view = viewOf(REVENUE);
    const chart = walk(ChartView({ view, testID: "chart-c1" }));
    const table = walk(ChartView({ view, testID: "chart-c1", mode: "table" }));
    // Chart mode: one element (the summary). Table mode: NOT one element, else
    // the table's cells are children of a single VoiceOver element.
    expect(chart[0]?.props.accessible).toBe(true);
    expect(table[0]?.props.accessible).toBe(false);
    // …and the table is reachable: the header reads the summary, and every
    // data row is its own stop (else the table would be one silent block).
    const stops = all(table, "View").filter((v) => v.props.accessible === true);
    expect(stops[0]?.props.accessibilityLabel).toBe(view.layout.summary);
    expect(stops.length).toBe(1 + view.layout.table.rows.length);
    expect(stops[1]?.props.accessibilityLabel).toBe("gennaio, 11.800 €, 10.200 €, ▲ 15,7%");
  });

  test("table mode: VoiceOver can still get back to the chart (the header carries the actions)", () => {
    const view = viewOf(REVENUE);
    const got: string[] = [];
    const tree = walk(
      ChartView({
        view,
        testID: "chart-c1",
        mode: "table",
        onAction: (a) => got.push(a),
      }),
    );
    // The root is no longer the element: the way back lives on the table's
    // first (header) stop, otherwise the toggle would be a one-way trip.
    expect(tree[0]?.props.accessibilityActions).toBeUndefined();
    const stops = all(tree, "View").filter((v) => v.props.accessible === true);
    const head = stops[0];
    const names = (head?.props.accessibilityActions as { name: string }[]).map((a) => a.name);
    expect(names).toEqual(["activate", "showChart"]);
    (head?.props.onAccessibilityAction as (e: unknown) => void)({
      nativeEvent: { actionName: "showChart" },
    });
    expect(got).toEqual(["showChart"]);
  });

  test("VoiceOver actions: open + show table, routed to onAction by name", () => {
    const view = viewOf(REVENUE);
    const got: string[] = [];
    const tree = walk(ChartView({ view, testID: "chart-c1", onAction: (a) => got.push(a) }));
    const actions = tree[0]?.props.accessibilityActions as { name: string }[];
    expect(actions.map((a) => a.name)).toEqual(["activate", "showTable"]);
    const fire = tree[0]?.props.onAccessibilityAction as (e: unknown) => void;
    fire({ nativeEvent: { actionName: "showTable" } });
    fire({ nativeEvent: { actionName: "bogus" } });
    expect(got).toEqual(["showTable"]);
  });

  test("the gesture handlers sit on the plot, not on the caption", () => {
    const view = viewOf(REVENUE);
    const onResponderGrant = () => {};
    const tree = walk(ChartView({ view, testID: "chart-c1", plotHandlers: { onResponderGrant } }));
    const plot = all(tree, "View").find((v) => v.props.testID === "chart-c1-plot");
    expect(plot?.props.onResponderGrant).toBe(onResponderGrant);
    expect(tree[0]?.props.onResponderGrant).toBeUndefined();
  });
});

describe("ChartFullScreenView — T7: landscape modal, toggles, table, share, close", () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const hidden = (over.hidden as Set<number> | undefined) ?? new Set<number>();
    const view = row.chartRowView(
      { name: "chart", args: JSON.stringify(REVENUE), status: "ok" },
      {
        width: 700,
        height: 240,
        hidden,
        fontScale: 1,
        locale: "it-IT",
        palette: theme.lightPalette,
      },
    );
    if (view === null) throw new Error("no view");
    const calls: string[] = [];
    const props = {
      view,
      testID: "chart-c1-full",
      words: interact.chartUiWords("it-IT"),
      chips: interact.seriesChips(REVENUE, hidden, "it-IT"),
      kpis: interact.fullScreenKpis(REVENUE, hidden, "it-IT"),
      mode: "chart" as const,
      scrub: null,
      reduceMotion: false,
      locale: "it-IT",
      palette: theme.lightPalette,
      insets: { top: 0, bottom: 21, left: 59, right: 59 },
      tableHeight: 240,
      onClose: () => calls.push("close"),
      onToggle: (k: number) => calls.push(`toggle:${k}`),
      onMode: (m: string) => calls.push(`mode:${m}`),
      onShare: () => calls.push("share"),
      ...over,
    };
    return { tree: walk(full.ChartFullScreenView(props as never)), calls, view };
  };
  const byId = (tree: Node[], type: string, id: string) =>
    all(tree, type).find((n) => n.props.testID === id);
  const press = (n: Node | undefined) => (n?.props.onPress as () => void)();

  test("a modal that can go landscape; Reduce Motion → no transition", () => {
    const modal = setup().tree[0];
    expect(modal?.type).toBe("Modal");
    expect(modal?.props.supportedOrientations).toEqual(["portrait", "landscape"]);
    expect(modal?.props.animationType).toBe("fade");
    expect(setup({ reduceMotion: true }).tree[0]?.props.animationType).toBe("none");
  });

  test("series chips toggle by index; table, share and close call their handlers", () => {
    const { tree, calls } = setup();
    press(byId(tree, "Pressable", "chart-c1-full-chip-1"));
    press(byId(tree, "Pressable", "chart-c1-full-table-toggle"));
    press(byId(tree, "Pressable", "chart-c1-full-share"));
    press(byId(tree, "Pressable", "chart-c1-full-close"));
    expect(calls).toEqual(["toggle:1", "mode:table", "share", "close"]);
  });

  test("a hidden series: its chip reads off, its line is gone, the other keeps its colour", () => {
    const { tree } = setup({ hidden: new Set([1]) });
    const chip = byId(tree, "Pressable", "chart-c1-full-chip-1");
    expect(chip?.props.accessibilityState).toEqual({ checked: false });
    const strokes = all(tree, "Path")
      .map((p) => p.props.stroke)
      .filter(Boolean);
    expect(strokes).toContain(seriesColor(0, "light"));
  });

  test("the KPI strip at rest; the scrub hero replaces it while scrubbing", () => {
    const rest = setup().tree;
    const texts = (t: Node[]) => all(t, "Text").map((n) => n.props.children);
    expect(texts(rest)).toContain("ULTIMO · ottobre");
    const { view } = setup();
    const scrub = view.layout.scrubAt(2);
    const scrubbing = setup({ scrub }).tree;
    expect(byId(scrubbing, "View", "chart-c1-full-kpis")).toBeUndefined();
    expect(JSON.stringify(texts(scrubbing))).toContain(scrub?.hero.num ?? "∅");
  });

  test("table mode: the full screen's table also carries the way back (showChart → chart)", () => {
    const { tree, calls } = setup({ mode: "table" });
    const stops = all(tree, "View").filter(
      (v) => v.props.accessible === true && v.props.accessibilityActions !== undefined,
    );
    const head = stops[0];
    const names = (head?.props.accessibilityActions as { name: string }[]).map((a) => a.name);
    expect(names).toEqual(["activate", "showChart"]);
    (head?.props.onAccessibilityAction as (e: unknown) => void)({
      nativeEvent: { actionName: "showChart" },
    });
    expect(calls).toEqual(["mode:chart"]);
  });

  test("table mode: the table with Δ in the plot's place (the plot was the element, the table is reachable)", () => {
    const { tree } = setup({ mode: "table" });
    expect(all(tree, "Svg")).toEqual([]);
    expect(byId(tree, "ScrollView", "chart-c1-full-table")?.props.style).toEqual({
      maxHeight: 240,
    });
    expect(all(tree, "Text").map((n) => n.props.children)).toContain("Δ");
  });
});

describe("TranscriptRow — a `chart` call draws the chart in the row's place", () => {
  const toolRow = (over: Record<string, unknown> = {}) => ({
    kind: "tool" as const,
    key: "k1",
    id: "c1",
    name: "chart",
    label: "Chart",
    args: JSON.stringify(REVENUE),
    status: "ok" as const,
    output: "Chart shown to the user: Ricavi",
    ...over,
  });
  type El = { type: unknown; props: unknown };
  const dispatch = (row: ReturnType<typeof toolRow>): El =>
    transcript.TranscriptRow({
      row,
      palette: theme.lightPalette,
      onLink: () => {},
      thumbnails: {} as never,
    }) as unknown as El;
  const call = (el: El): El => (el.type as (p: unknown) => El)(el.props);
  const nameOf = (el: El): string =>
    typeof el.type === "function" ? (el.type as { name: string }).name : String(el.type);
  /** The dispatcher's pick, one level down when it is the chart row. */
  const pick = (row: ReturnType<typeof toolRow>): string => {
    const el = dispatch(row);
    return nameOf(nameOf(el) === "ChartRowView" ? call(el) : el);
  };
  const ids = (nodes: Node[], out: string[] = []): string[] => {
    for (const n of nodes) {
      if (typeof n.props.testID === "string") out.push(n.props.testID);
      ids(n.children, out);
    }
    return out;
  };

  test("valid spec → the chart, full width, no tool chrome", () => {
    const tree = walk(call(dispatch(toolRow())));
    const block = all(tree, "ChartBlock")[0];
    expect(block?.props.testID).toBe("chart-c1");
    expect(ids(tree).some((id) => id.startsWith("tool-c1"))).toBe(false);
    const view = block?.props.view as Parameters<typeof ChartView>[0]["view"];
    const inner = walk(ChartView({ view, testID: "chart-c1" }));
    expect(ids(inner)).toContain("chart-c1");
    expect(all(inner, "Svg")[0]?.props.width).toBe(390 - 2 * theme.space.inset);
  });

  test("forged spec, failed call or another tool → the generic tool row", () => {
    const forged = JSON.stringify({ ...REVENUE, datasets: [{ label: "x", data: ["12.5"] }] });
    expect(pick(toolRow({ args: forged }))).toBe("ToolRowView");
    expect(pick(toolRow({ status: "error" }))).toBe("ToolRowView");
    expect(pick(toolRow({ name: "fs_write" }))).toBe("ToolRowView");
    expect(pick(toolRow())).toBe("Shell");
  });
});
