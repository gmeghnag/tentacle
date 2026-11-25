/**
 * Review's header caption (e2e fix round 2, docs/feat/workflow-editor.md D8):
 * "Nothing written yet" in the header caption until confirmed — the mockup's
 * `editorHeader({ title: "Review", caption: "nothing written yet" })`
 * (`.tentacle/mockups/workflow-editor/index.html:626`) and the doc's words.
 *
 * The bug this file pins: the caption was passed to `ScreenHeader`'s `subtitle`
 * as a raw STRING, and React Native does not render one — `subtitle` is a
 * `ReactNode` slot meant for an ELEMENT, so a bare string produced an
 * `RCTRawText` with no `<Text>` around it and drew nothing (the JSX around it
 * swallowed the warning; the device dump of flow 44 step 74 has the title and no
 * caption at all). REVIEWED BY CONTRACT: the caption is drawn only inside a
 * `Text`, so a screen that forgets is caught here and not on a simulator.
 *
 * Rendered, not source-pinned (AGENTS §7): `react-native`, `expo-symbols` and
 * `react-native-safe-area-context` are mocked to host stubs (the
 * `row-a11y.test.ts` pattern — string element types, so the walker keeps them).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Fragment, createElement as h, isValidElement } from "react";

/** One node of the walked element tree: a host stub, or something unexpected. */
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

/** Every host node, flattened. */
const hosts = (nodes: readonly Node[]): Node[] =>
  nodes.flatMap((node) => [node, ...hosts(node.children)]);

/** The `Text` nodes whose OWN children include this exact string. */
const textsSaying = (nodes: readonly Node[], text: string): Node[] =>
  hosts(nodes).filter(
    (node) =>
      node.type === "Text" &&
      (Array.isArray(node.props.children)
        ? node.props.children.includes(text)
        : node.props.children === text),
  );

/** Strings rendered OUTSIDE a `Text` — what React Native cannot draw. */
const rawStrings = (nodes: readonly Node[], inText = false): string[] =>
  nodes.flatMap((node) => {
    const here = node.type === "Text";
    const kids = node.props.children;
    const own = (typeof kids === "string" && !here ? [kids] : []).concat(
      Array.isArray(kids)
        ? kids.filter((kid): kid is string => typeof kid === "string" && !here)
        : [],
    );
    const nested = inText || here;
    return [...own, ...rawStrings(node.children, nested)];
  });

const CAPTION = "nothing written yet";

describe("Review's header: the caption is DRAWN, not a raw string", () => {
  let theme: typeof import("../src/theme.ts");
  let review: typeof import("../src/screens/WorkflowEditReview.tsx");

  beforeAll(async () => {
    mock.module("react-native", () => ({
      ActivityIndicator: "ActivityIndicator",
      Modal: "Modal",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
      AccessibilityInfo: {
        isReduceMotionEnabled: async () => false,
        addEventListener: () => ({ remove: () => {} }),
      },
      LayoutAnimation: { configureNext: () => {}, create: () => ({}), Types: {}, Properties: {} },
      useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
    }));
    mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
    mock.module("react-native-safe-area-context", () => ({
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    }));
    mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
    theme = await import("../src/theme.ts");
    review = await import("../src/screens/WorkflowEditReview.tsx");
  });

  afterAll(() => {
    mock.restore();
  });

  const draw = (): readonly Node[] =>
    walk(
      review.WorkflowEditReview({
        palette: theme.lightPalette,
        model: {
          rows: [{ path: ".tentacle/workflows/task.yaml", value: "new · 9 lines" }],
          patches: [],
          hash: "7b04d2aa",
          version: "1",
          hashFoot: "The hash covers the file and its prompts.",
          notes: [],
          button: "Save 1 file",
        },
        canConfirm: true,
        saving: false,
        notice: null,
        onBack: () => {},
        onConfirm: () => {},
      }),
    );

  test("`nothing written yet` is a Text, so the device shows it", () => {
    // Mutation: pass the string straight as `subtitle` (the pre-fix code) → red.
    const nodes = draw();
    expect(textsSaying(nodes, CAPTION).length).toBe(1);
    // And it is the header's caption, under the "Review" title.
    const title = hosts(nodes).find((node) => node.props.testID === "workflow-review-title");
    expect(title).toBeDefined();
  });

  test("no screen string is rendered outside a Text (an RCTRawText draws nothing)", () => {
    // The class-level guard: any bare string in a header/screen slot is the same
    // bug, so the whole tree is swept, not just the caption.
    expect(rawStrings(draw())).toEqual([]);
  });
});

describe("every header caption slot wraps a string in a Text", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");

  test("ScreenHeader: both branches go through the wrapper, never `{subtitle}` raw", () => {
    // Mutation: `{subtitle}` straight into the View (the pre-fix code) → red,
    // because a screen may legally pass a string and then it draws nothing.
    const source = read("ui", "ScreenHeader.tsx");
    expect(source).toMatch(/typeof subtitle === "string"/);
    // Comments name the trap; only CODE is judged (the `code()` idiom).
    const body = source
      .split("\n")
      .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
      .join("\n");
    // Two call sites (compact + large)…
    expect(body.match(/\{subtitleNode\(subtitle, palette\)\}/g)?.length).toBe(2);
    // …and the wrapper's own `{subtitle}` is the ONLY one, inside its Text.
    expect(body.match(/\{subtitle\}/g)?.length).toBe(1);
  });

  test("Sheet: the same slot already wraps (why its two plain captions work)", () => {
    const source = read("ui", "Sheet.tsx");
    expect(source.match(/\{subtitle === undefined \? null :/g)?.length).toBe(2);
    expect(source.match(/\{subtitle\}/g)?.length).toBe(2);
  });
});
