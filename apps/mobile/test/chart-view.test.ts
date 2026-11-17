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
  }));
  mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
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

  test("no card: no frame <Rect>, and the container has no background, radius, border or shadow", () => {
    const { tree } = render(REVENUE);
    expect(all(tree, "Rect")).toEqual([]);
    const root = flat(tree[0]?.props.style);
    for (const key of ["backgroundColor", "borderRadius", "borderWidth", "shadowOpacity"]) {
      expect(root[key]).toBeUndefined();
    }
  });

  test("every layout text and dot is drawn; chart text is monospace", () => {
    const { tree, view } = render(REVENUE);
    const texts = all(tree, "SvgText");
    expect(texts.map((t) => t.props.children)).toEqual(view.layout.texts.map((t) => t.text));
    for (const t of texts) expect(t.props.fontFamily).toBe(theme.MONO);
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
    const found = ids(tree);
    expect(found).toContain("chart-c1");
    expect(found.some((id) => id.startsWith("tool-c1"))).toBe(false);
    expect(all(tree, "Svg")[0]?.props.width).toBe(390 - 2 * theme.space.inset);
  });

  test("forged spec, failed call or another tool → the generic tool row", () => {
    const forged = JSON.stringify({ ...REVENUE, datasets: [{ label: "x", data: ["12.5"] }] });
    expect(pick(toolRow({ args: forged }))).toBe("ToolRowView");
    expect(pick(toolRow({ status: "error" }))).toBe("ToolRowView");
    expect(pick(toolRow({ name: "fs_write" }))).toBe("ToolRowView");
    expect(pick(toolRow())).toBe("Shell");
  });
});
