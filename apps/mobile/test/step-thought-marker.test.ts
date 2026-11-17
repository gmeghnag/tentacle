/**
 * fix/mobile-step-thought-marker (owner 17/11): the ∴ did not mean "there is a
 * thought here" — it sat next to a command's duration (`Bash ls ∴ 22 ms`) and
 * read as part of it. A tool step now NEVER draws it; the ∴ belongs to reasoning
 * (an orphan Thought row, the live Thinking footer), and a folded thought is
 * still the open body's first line, so nothing is lost.
 *
 * The row under test is the REAL `TranscriptRow`, called one component at a time
 * (its `StepShell` → `StepNode` props are plain objects: `StepNode` itself runs
 * hooks, so it is never called — `chart-view.test.ts`'s pattern).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");
let theme: typeof import("../src/theme.ts");

beforeAll(async () => {
  const { mock } = await import("bun:test");
  // A superset of chart-view.test.ts's stubs: Bun keeps the FIRST mock's export
  // shape for a module across files, and this file imports the whole row module.
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
      loop: () => ({ start: () => {}, stop: () => {} }),
      multiply: () => 0,
    },
    Easing: { linear: (t: number) => t, bezier: () => (t: number) => t },
    Share: { share: async () => ({}) },
  }));
  mock.module("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
  transcript = await import("../src/screens/transcript/TranscriptRow.tsx");
  theme = await import("../src/theme.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

/** A screen-owned step: its layout cell (the folded thought), closed. */
const stepOf = (thought: string | null) => ({
  cell: { kind: "step" as const, thought, thread: { up: false, down: false } },
  open: false,
  full: false,
  reduceMotion: false,
  onToggle: () => {},
  onShowAll: () => {},
});

const nameOf = (type: unknown): string =>
  typeof type === "function" ? (type as { name: string }).name : String(type);

const shellOf = (row: Record<string, unknown>, step?: ReturnType<typeof stepOf>): Element => {
  const props = {
    row,
    palette: theme.lightPalette,
    onLink: () => {},
    thumbnails: {},
    ...(step === undefined ? {} : { step }),
  };
  const el = transcript.TranscriptRow(
    props as unknown as Parameters<typeof transcript.TranscriptRow>[0],
  ) as unknown as Element;
  // `TranscriptRow` is a dispatcher: `ToolRowView` / `ReasoningRowView` → shell.
  const named = (name: string) => name === "ToolRowView" || name === "ReasoningRowView";
  let node = el;
  for (let i = 0; i < 4 && named(nameOf(node.type)); i += 1) {
    node = (node.type as (p: unknown) => unknown)(node.props) as Element;
  }
  expect(nameOf(node.type)).toBe("StepShell");
  return node;
};

/** The `StepNode` props of a `StepShell` row (the shell's one child). */
const stepNodeOf = (
  row: Record<string, unknown>,
  step?: ReturnType<typeof stepOf>,
): Record<string, unknown> => {
  const shell = shellOf(row, step);
  expect(nameOf(shell.type)).toBe("StepShell");
  const inner = (shell.type as (p: unknown) => unknown)(shell.props) as Element;
  const children = inner.props.children;
  const node = (Array.isArray(children) ? children[0] : children) as Element;
  expect(nameOf(node.type)).toBe("StepNode");
  return node.props;
};

const TOOL = {
  kind: "tool" as const,
  key: "c1",
  id: "c1",
  name: "bash",
  label: "Bash",
  args: JSON.stringify({ command: "ls -la" }),
  status: "ok" as const,
  output: "a\nb",
};

describe("a tool step's line carries no ∴ (owner 17/11)", () => {
  test("a tool step with a folded thought draws no marker beside its duration", () => {
    const props = stepNodeOf(TOOL, stepOf("I should list the files first"));
    // The row's line is name + mono subtitle + trailing text; the ∴ is gone.
    expect("marker" in props).toBe(false);
    // …and the going-away is safe: the folded thought is the body's first line,
    // still drawn with its own ∴ (a mutation that swaps the body's text fails here).
    const body = props.body as { type: { name: string }; props: Record<string, unknown> };
    expect(nameOf(body.type)).toBe("StepBody");
    const drawn = body.type as unknown as (p: unknown) => unknown;
    const items = (drawn(body.props) as { props: { children: unknown } }).props
      .children as Element[];
    expect(nameOf(items[0]?.type)).toBe("View");
    const marks = (items[0]?.props.children as Element[])[0];
    expect(nameOf(marks?.type)).toBe("ThereforeDots");
    expect(((items[0]?.props.children as Element[])[1] as Element).props.children).toBe(
      "I should list the files first",
    );
  });

  test("a tool step without a thought draws no marker either", () => {
    expect("marker" in stepNodeOf(TOOL, stepOf(null))).toBe(false);
    expect("marker" in stepNodeOf(TOOL)).toBe(false);
  });

  test("a live command (a duration counting up) has no marker", () => {
    const running = { ...TOOL, status: "running" as const, output: "", at: Date.now() };
    expect("marker" in stepNodeOf(running, stepOf("checking"))).toBe(false);
  });

  test("a Thought row is still a ∴ node — the reasoning keeps its marker", () => {
    const reasoning = {
      kind: "reasoning" as const,
      key: "r1",
      text: "Weighing the options\nand the cost",
    };
    const props = stepNodeOf(reasoning);
    expect(props.node).toBe("thought");
    expect(props.subtitle).toBe("Weighing the options");
    expect("marker" in props).toBe(false);
  });
});

describe("StepNode: the trailing marker is gone from the renderer", () => {
  const node = readFileSync(join(SRC, "ui", "StepNode.tsx"), "utf8");
  const row = readFileSync(join(SRC, "screens", "transcript", "TranscriptRow.tsx"), "utf8");

  test("no `marker` prop, no `styles.marker`, no second ∴ on a line", () => {
    expect(node).not.toMatch(/readonly marker:/);
    expect(node).not.toContain("styles.marker");
    expect(node).not.toMatch(/marker=\{(?:true|false|[^}]*)\}/);
    // The remaining ∴ are the reasoning node and the folded thought in the body.
    expect(node.match(/<ThereforeDots\b/g)?.length).toBe(2);
  });

  test("no caller passes a marker", () => {
    expect(row).not.toContain("marker=");
  });
});
