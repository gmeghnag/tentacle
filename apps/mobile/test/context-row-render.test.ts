/**
 * A context reset / a compaction DRAWN as a rail step
 * (docs/feat/mobile-reset-in-timeline.md Slice 3): the decisions are pure —
 * `contextRowView` (`tool-steps.ts`, tested in `tool-steps.test.ts`) hands over
 * the node, the name, the subtitle, the cut body and the a11y label; this pins
 * that `TranscriptRow` maps them to a `StepNode` and that the body is the
 * MARKDOWN of the step, opened only while the screen says so, with the show-all
 * line only when the cut held something back.
 *
 * Host stubs are STRING element types and `StepNode` / `Markdown` are never
 * called (`notice-row.test.ts` / `step-thought-marker.test.ts` patterns: the
 * former's `mock.module`s, because this file imports the whole row module; the
 * latter's rule, because `StepNode` runs hooks and cannot be called as a plain
 * function).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Fragment, isValidElement } from "react";

interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

const nameOf = (type: unknown): string =>
  typeof type === "function" ? ((type as { name?: string }).name ?? "") : String(type);

/** Components that must never be CALLED while walking: they run hooks. */
const HOOKS = new Set(["StepNode"]);

/**
 * Walk an element tree, calling the plain function components (so the row's own
 * components are really exercised) and STOPPING at `stop`: those are recorded
 * with their props and never invoked.
 */
const walk = (element: unknown, stop: ReadonlySet<string> = HOOKS, out: Node[] = []): Node[] => {
  if (element === null || element === undefined || typeof element === "boolean") return out;
  if (Array.isArray(element)) {
    for (const child of element) walk(child, stop, out);
    return out;
  }
  if (!isValidElement(element)) return out;
  const { type, props } = element as { type: unknown; props: Record<string, unknown> };
  if (type === Fragment) {
    walk(props.children, stop, out);
    return out;
  }
  if (typeof type === "function") {
    if (stop.has(nameOf(type))) {
      out.push({ type, props, children: [] });
      return out;
    }
    walk((type as (p: Record<string, unknown>) => unknown)(props), stop, out);
    return out;
  }
  const node: Node = { type, props, children: [] };
  out.push(node);
  walk(props.children, stop, node.children);
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

const drawn = (nodes: readonly Node[]): string => texts(nodes).join("");

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");
let theme: typeof import("../src/theme.ts");

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
  // The text seam (docs/feat/mobile-theme-beta.md) reads the app font from a
  // context; this walker calls components without React, so it is stubbed to the
  // same host strings `react-native`'s Text/TextInput are.
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
  transcript = await import("../src/screens/transcript/TranscriptRow.tsx");
  theme = await import("../src/theme.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

type Row = Record<string, unknown>;

/** A step's screen-owned state: `stepLayout`'s cell and the per-key open state. */
const stepOf = (open = false, full = false, thread = { up: true, down: true }) => ({
  cell: { kind: "context" as const, thread },
  open,
  full,
  reduceMotion: false,
  onToggle: () => {},
  onShowAll: () => {},
});

const RESET: Row = {
  kind: "context",
  key: "x1",
  event: "reset",
  body: "Carry on with the **plan**\n\nsecond line",
  at: 1_700_000_000_000,
};

const COMPACT: Row = {
  kind: "context",
  key: "x2",
  event: "compact",
  body: "## Summary\n\nWe did the thing",
  figures: "ctx 182k → 9k",
};

/** The row's tree, down to the `StepNode` it draws (never called: hooks). */
function nodesOf(row: Row, step?: ReturnType<typeof stepOf>): readonly Node[] {
  return walk(
    transcript.TranscriptRow({
      row: row as never,
      palette: theme.lightPalette,
      onLink: () => {},
      thumbnails: {},
      ...(step === undefined ? {} : { step }),
    } as never),
  );
}

/** Every node of `type` under `nodes`, depth first (the walk nests children). */
const byName = (nodes: readonly Node[], name: string, out: Node[] = []): Node[] => {
  for (const node of nodes) {
    if (nameOf(node.type) === name) out.push(node);
    byName(node.children, name, out);
  }
  return out;
};

/** The one `StepNode` a context row draws, with its props. */
function nodeOf(row: Row, step?: ReturnType<typeof stepOf>): Record<string, unknown> {
  const node = byName(nodesOf(row, step), "StepNode")[0];
  expect(node).toBeDefined();
  return node?.props ?? {};
}

/** Every string the open body DRAWS (its `Markdown` really rendered). */
const bodyText = (props: Record<string, unknown>): string =>
  drawn(walk(props.body, new Set(["StepNode"])));

/** The open body's tree, walked until its `Markdown` (so the parse is observable). */
const bodyOf = (props: Record<string, unknown>): Record<string, unknown> => {
  const md = byName(walk(props.body, new Set([...HOOKS, "Markdown"])), "Markdown")[0];
  expect(md).toBeDefined();
  return md?.props ?? {};
};

describe("a reset is ONE rail step, closed until tapped", () => {
  test("the node, the name in words, the prompt's first line italic, the a11y label", () => {
    const props = nodeOf(RESET, stepOf());
    expect(props.node).toBe("reset");
    expect((props.name as { tool: string }).tool).toBe("Context reset");
    expect(props.subtitle).toBe("Carry on with the plan");
    expect(props.subtitleItalic).toBe(true);
    // The screen owns the open state (survives cell recycling): never `useState`.
    expect(props.open).toBe(false);
    // Closed = NO body element at all, so a closed step parses nothing.
    expect(props.body).toBeUndefined();
    expect(props.thread).toEqual({ up: true, down: true });
    expect(typeof props.onToggle).toBe("function");
    expect(props.a11yLabel).toBe("Context reset. Restart prompt: Carry on with the plan");
  });

  test("a compaction: the `compact` node, the figures mono (not italic), spoken in words", () => {
    const props = nodeOf(COMPACT, stepOf());
    expect(props.node).toBe("compact");
    expect((props.name as { tool: string }).tool).toBe("Compacted");
    expect(props.subtitle).toBe("ctx 182k → 9k");
    expect(props.subtitleItalic).toBe(false);
    // The `→` is spoken (`tool-steps.ts` `spokenFigures`): an exact figure says
    // "to", a `~` figure adds "about" (Slice 2's own test pins both).
    expect(props.a11yLabel).toBe("Compacted, context 182k to 9k");
  });

  test("no `StepProps` (a row drawn on its own) is still a lone, closed step", () => {
    const props = nodeOf(RESET);
    expect(props.open).toBe(false);
    expect(props.thread).toEqual({ up: false, down: false });
    // Nothing to open without the screen's state: no toggle, and no empty
    // expansion either (`ui-empty-action-standard`).
    expect(props.onToggle).toBeUndefined();
    expect(props.body).toBeUndefined();
  });
});

describe("opened, the step draws its body as MARKDOWN, in secondary grey", () => {
  test("the body is the parsed markdown of the prompt, tinted `sec`", () => {
    const props = nodeOf(RESET, stepOf(true));
    const md = bodyOf(props);
    // Parsed, not quoted: the marks are gone and the text is in the tree.
    expect(JSON.stringify(md.parsed)).toContain("Carry on with the ");
    expect(JSON.stringify(md.parsed)).toContain("second line");
    // A step's body is a FACT about the run: `sec`, like every other step line
    // (the owner is colour-blind — weight, never hue alone).
    expect((md.palette as { label: string }).label).toBe(theme.lightPalette.sec);
    expect(typeof md.onLink).toBe("function");
    // Drawn for real: the rendered body carries its words.
    expect(bodyText(props)).toContain("Carry on with the ");
    expect(bodyText(props)).toContain("second line");
  });

  test("nothing held back = no show-all line; a cut body offers it", () => {
    expect(bodyText(nodeOf(RESET, stepOf(true)))).not.toContain("more line");
    const long: Row = {
      ...RESET,
      body: Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join("\n"),
    };
    expect(bodyText(nodeOf(long, stepOf(true)))).toContain("… 8 more lines · tap to see all");
    // The offer is the SCREEN's show-all (`step.onShowAll`, survives recycling):
    // the Pressable that DRAWS the offer line carries the callback.
    const offer = all(
      walk(nodeOf(long, stepOf(true)).body, new Set(["StepNode"])),
      "Pressable",
    ).find((node) => drawn([node]).includes("tap to see all"));
    expect(offer).toBeDefined();
    expect(typeof offer?.props.onPress).toBe("function");
    // The cap is `CONTEXT_BODY_LINES` SOURCE lines (Slice 2's pure cut).
    const md = bodyOf(nodeOf(long, stepOf(true)));
    expect(JSON.stringify(md.parsed)).toContain("line 12");
    expect(JSON.stringify(md.parsed)).not.toContain("line 13");
    // `full` (the show-all tap) draws every line and drops the offer.
    expect(bodyText(nodeOf(long, stepOf(true, true)))).not.toContain("tap to see all");
    expect(JSON.stringify(bodyOf(nodeOf(long, stepOf(true, true))).parsed)).toContain("line 20");
  });

  test("a blank body is never an empty expansion: no toggle, no body", () => {
    const blank: Row = { ...RESET, body: "" };
    const props = nodeOf(blank, stepOf(true));
    expect(props.onToggle).toBeUndefined();
    expect(props.body).toBeUndefined();
  });
});
