/**
 * The preview card's RENDER (docs/feat/mobile-file-preview-cards.md): the
 * decisions are `artifact-preview.test.ts`'s; this pins that the component maps
 * them — band or none, top-aligned page, disabled when gone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
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

/** The nodes whose `testID` is `id`. */
const byTestId = (nodes: readonly Node[], id: string): readonly Node[] =>
  [...all(nodes, "View"), ...all(nodes, "Image"), ...all(nodes, "Pressable")].filter(
    (node) => node.props.testID === id,
  );

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");
let theme: typeof import("../src/theme.ts");
let preview: typeof import("../src/artifact-preview.ts");

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
  preview = await import("../src/artifact-preview.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

/** The symbol names drawn under `nodes` (`Icon` → `SymbolView name=…`). */
const symbols = (nodes: readonly Node[]): readonly string[] =>
  all(nodes, "SymbolView").map((node) => String(node.props.name));

const W = 358;

function meta(over: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    artifactId: "rep",
    version: 1,
    sha256: "f".repeat(64),
    size: 214_000,
    mimeType: "application/pdf",
    kind: "pdf",
    title: "Q3 Infrastructure Report",
    callId: "call-1",
    createdAt: 0,
    ...over,
  };
}

function draw(m: ArtifactMeta, status: Parameters<typeof preview.previewCardView>[1]): Node[] {
  const view = preview.previewCardView(m, status, W);
  return walk(
    transcript.ArtifactCardBody({
      view,
      artifactId: m.artifactId,
      palette: theme.paletteFor("light"),
      width: W,
      onPress: () => {},
    }),
  );
}

describe("ArtifactCardBody — the preview card as drawn", () => {
  test("loading: a band of the final height holding the symbol, then the meta row + chevron", () => {
    const nodes = draw(meta({}), { kind: "loading" });
    const band = byTestId(nodes, "artifact-card-band-loading");
    expect(band).toHaveLength(1);
    expect(JSON.stringify(band[0]?.props.style)).toContain('"height":150');
    expect(texts(nodes)).toEqual(["Q3 Infrastructure Report", "PDF · 214 KB"]);
    expect(symbols(nodes)).toContain("chevron.right");
  });

  test("a ready page is drawn at the band's width, TOP-aligned (never RN's centring cover)", () => {
    const nodes = draw(meta({}), {
      kind: "ready",
      preview: { kind: "picture", uri: "file:///p.jpg", width: 1074, height: 1611, pages: 7 },
    });
    const image = byTestId(nodes, "artifact-card-thumbnail")[0];
    expect(image?.props.style).toEqual({
      position: "absolute",
      top: 0,
      left: 0,
      width: W,
      height: 537,
    });
    expect(texts(nodes)).toContain("PDF · 7 pages · 214 KB");
  });

  test("ready markdown: its first lines, a bullet marked by its glyph", () => {
    const nodes = draw(meta({ kind: "markdown", mimeType: "text/markdown" }), {
      kind: "ready",
      preview: { kind: "lines", text: "# Plan\n\n- Freeze" },
    });
    expect(byTestId(nodes, "artifact-card-band-lines")).toHaveLength(1);
    expect(texts(nodes).slice(0, 2)).toEqual(["Plan", "•  Freeze"]);
  });

  test("gone: no band, no chevron, the Pressable disabled, the words say why", () => {
    const nodes = draw(meta({}), { kind: "gone" });
    expect(byTestId(nodes, "artifact-card-band-loading")).toHaveLength(0);
    expect(byTestId(nodes, "artifact-card-band-symbol")).toHaveLength(0);
    expect(symbols(nodes)).not.toContain("chevron.right");
    const card = byTestId(nodes, "artifact-card-rep")[0];
    expect(card?.props.disabled).toBe(true);
    expect(card?.props.accessibilityState).toEqual({ disabled: true });
    expect(texts(nodes)).toContain("PDF · 214 KB · no longer available");
  });

  test("failed: the band stays, the symbol at full strength (never an empty box)", () => {
    const nodes = draw(meta({ kind: "html", mimeType: "text/html" }), { kind: "failed" });
    const band = byTestId(nodes, "artifact-card-band-symbol");
    expect(band).toHaveLength(1);
    expect(symbols(band[0]?.children ?? [])).toHaveLength(1);
  });
});
