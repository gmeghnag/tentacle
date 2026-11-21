/**
 * The gallery's chart TILE (docs/feat/model-charts.md slice C8, mobile-gallery-polish): a dumb renderer
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

let thumbnail: typeof import("../src/ui/chart/ChartThumbnail.tsx");
let thumbs: typeof import("../src/chart-thumb.ts");
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
  // The text seam (docs/feat/mobile-theme-beta.md) reads the app font from a
  // context; this walker calls components without React, so it is stubbed
  // to the same host strings `react-native`'s Text/TextInput are.
  mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
  mock.module("react-native-svg", () => ({
    default: "Svg",
    Svg: "Svg",
    Circle: "Circle",
    ClipPath: "ClipPath",
    G: "G",
    Line: "Line",
    Path: "Path",
    Rect: "Rect",
  }));
  thumbnail = await import("../src/ui/chart/ChartThumbnail.tsx");
  thumbs = await import("../src/chart-thumb.ts");
  theme = await import("../src/theme.ts");
  fixtures = await import("./chart-fixtures.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

// Read at CALL time: the modules are imported in `beforeAll` (after the mocks).
const LIST = { width: 52, height: 52 } as const;
const thumbOf = (raw: unknown, box: { width: number; height: number } = LIST) => {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const meta = {
    artifactId: "x",
    version: 1,
    sha256: "a".repeat(64),
    size: bytes.length,
    mimeType: "application/vnd.tentacle.chart+json",
    kind: "chart",
    title: "x",
    callId: "c1",
    createdAt: 0,
  };
  const g = thumbs.chartThumbGeometry(meta, bytes, {
    fontScale: 1,
    locale: "it",
    palette: theme.lightPalette,
  });
  if (g === null) throw new Error("no geometry");
  const t = thumbs.chartThumbAt(g, box);
  if (t === null) throw new Error("not legible");
  return t;
};

describe("ChartThumbnail — the marks, and only the marks, inside the tile", () => {
  test("the Svg is the tile's size and scales the drawing through the view box", () => {
    const thumb = thumbOf(fixtures.REVENUE);
    const tree = walk(thumbnail.ChartThumbnail({ thumb, testID: "thumb-1" }));
    const svg = all(tree, "Svg")[0];
    expect(svg?.props.width).toBe(52);
    expect(svg?.props.height).toBe(52);
    expect(svg?.props.viewBox).toBe(thumbs.viewBoxAttr(thumb.viewBox));
    expect(svg?.props.preserveAspectRatio).toBe("xMidYMid meet");
    // Every mark is drawn; NO text and NO guide line: a tile cannot hold them.
    expect(all(tree, "Path").length).toBe(thumb.paths.length);
    expect(all(tree, "SvgText")).toEqual([]);
    expect(all(tree, "Line")).toEqual([]);
  });

  test("the root clips: nothing it draws can reach the rows below", () => {
    const thumb = thumbOf(fixtures.REVENUE);
    const root = walk(thumbnail.ChartThumbnail({ thumb, testID: "thumb-2" }))[0];
    const style = [root?.props.style].flat(2) as Record<string, unknown>[];
    expect(style.some((s) => s?.overflow === "hidden")).toBe(true);
    expect(style.some((s) => s?.width === 52 && s?.height === 52)).toBe(true);
  });

  test("a doughnut draws its sectors and NOT its legend chips", () => {
    const thumb = thumbOf({
      type: "doughnut",
      title: "Budget",
      labels: ["a", "b", "c"],
      datasets: [{ label: "v", data: [5, 3, 2] }],
    });
    const tree = walk(thumbnail.ChartThumbnail({ thumb, testID: "thumb-3" }));
    expect(all(tree, "Path").length).toBe(3);
    expect(thumb.paths.every((p) => p.role === "sector")).toBe(true);
  });

  test("a scatter draws its dots", () => {
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
    const thumb = thumbOf(scatter);
    const tree = walk(thumbnail.ChartThumbnail({ thumb, testID: "thumb-4" }));
    expect(thumb.dots.length).toBe(3);
    expect(all(tree, "Circle").length).toBeGreaterThanOrEqual(3);
  });

  test("it carries the summary as its accessibility label (one element, `image`)", () => {
    const thumb = thumbOf(fixtures.REVENUE);
    const root = walk(thumbnail.ChartThumbnail({ thumb, testID: "thumb-5" }))[0];
    expect(root?.props.accessibilityLabel).toBe(thumb.view.layout.summary);
    expect(root?.props.accessibilityRole).toBe("image");
  });
});
