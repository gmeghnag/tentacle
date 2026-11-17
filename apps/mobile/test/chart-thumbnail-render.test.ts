/**
 * The gallery's chart TILE (docs/feat/model-charts.md slice C8): a dumb renderer
 * of `chartThumbView`'s layout — `paths` + `dots` only, no axis texts, no
 * caption — at the size the row's tile gives it (T8.1).
 *
 * The mocks are `chart-view.test.ts`'s minimal superset: Bun keeps the FIRST
 * mock's export shape for a module across files, so this file stubs exactly what
 * `ChartThumbnail.tsx` imports and nothing that another file's mock would miss.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isValidElement } from "react";

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

let thumb: typeof import("../src/ui/chart/ChartThumbnail.tsx");
let row: typeof import("../src/chart-row.ts");
let theme: typeof import("../src/theme.ts");
let fixtures: typeof import("./chart-fixtures.ts");

beforeAll(async () => {
  const { mock } = await import("bun:test");
  // chart-view.test.ts's stub set, verbatim: Bun keeps the FIRST mock's export
  // shape for a module across the run, so every file must offer the same names.
  mock.module("react-native", () => ({
    Text: "Text",
    View: "View",
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
  }));
  mock.module("react-native-svg", () => ({
    default: "Svg",
    Svg: "Svg",
    Circle: "Circle",
    G: "G",
    Line: "Line",
    Path: "Path",
  }));
  thumb = await import("../src/ui/chart/ChartThumbnail.tsx");
  row = await import("../src/chart-row.ts");
  theme = await import("../src/theme.ts");
  fixtures = await import("./chart-fixtures.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

// Read at CALL time: `theme` is imported in `beforeAll` (after the mocks).
const tile = () => ({
  width: 44,
  height: 32,
  fontScale: 1,
  locale: "it",
  palette: theme.lightPalette,
});

describe("ChartThumbnail — the plot, and only the plot", () => {
  test("it draws the layout's paths and dots at the tile's size", () => {
    const view = row.chartRowView(
      { name: "chart", args: JSON.stringify(fixtures.REVENUE), status: "ok" },
      tile(),
    );
    if (view === null) throw new Error("no view");
    const tree = walk(thumb.ChartThumbnail({ view, testID: "thumb-1" }));
    const svg = all(tree, "Svg")[0];
    expect(svg?.props.width).toBe(44);
    expect(svg?.props.height).toBe(32);
    // Every path in the layout is drawn (a tile never drops a series), and NO
    // axis text is: a 44 pt tile cannot hold a label, and the row above it
    // already says the title.
    expect(all(tree, "Path").length).toBeGreaterThanOrEqual(view.layout.paths.length);
    expect(all(tree, "SvgText")).toEqual([]);
  });

  test("a `chart` with dots (scatter) draws them; a line chart simply has none", () => {
    const scatter = fixtures.spec({
      type: "scatter",
      title: "Latenza",
      labels: [1, 2, 3],
      datasets: [
        {
          label: "p99",
          data: [
            { x: 1, y: 4 },
            { x: 2, y: 9 },
            { x: 3, y: 6 },
          ],
        },
      ],
    });
    const view = row.chartRowView(
      { name: "chart", args: JSON.stringify(scatter), status: "ok" },
      tile(),
    );
    if (view === null) throw new Error("no view");
    const tree = walk(thumb.ChartThumbnail({ view, testID: "thumb-2" }));
    expect(all(tree, "Circle").length).toBeGreaterThanOrEqual(view.layout.dots.length);
    expect(view.layout.dots.length).toBeGreaterThan(0);
  });

  test("it carries the summary as its accessibility label (one element, `image`)", () => {
    const view = row.chartRowView(
      { name: "chart", args: JSON.stringify(fixtures.REVENUE), status: "ok" },
      tile(),
    );
    if (view === null) throw new Error("no view");
    const root = walk(thumb.ChartThumbnail({ view, testID: "thumb-3" }))[0];
    expect(root?.props.accessibilityLabel).toBe(view.layout.summary);
    expect(root?.props.accessibilityRole).toBe("image");
  });
});
