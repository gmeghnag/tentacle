/**
 * How a row is exposed to VoiceOver — the COMPONENT half (fix round 1,
 * docs/fix/mobile-e2e-reds.md Review MEDIUM). `row-value.ts` decides (`group`,
 * `textButton`, and what a trailing element IS); `ui/Row.tsx` only renders.
 *
 * The bug this file pins: `Row` treated ANY defined `trailing` as a control, so a
 * row carrying a plain value (`null`, a `<Text>` reason, Session info's
 * read-only `values`) stopped being one element — its label and its value were
 * read as two, and a ready Commands row's own tap stopped being the row's.
 *
 * Rendered, not source-pinned (AGENTS §7): the mapping is exactly the kind of
 * component logic a grep cannot hold. `react-native`, `expo-symbols` and
 * `react-native-safe-area-context` are mocked to host stubs — string element
 * types, so the walker keeps them as nodes (a function stub would be called and
 * its result dropped, and every assertion would pass on an empty tree).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Fragment, createElement as h, isValidElement } from "react";
import { COMPACTING, type CommandRow } from "../src/session-commands.ts";
import type { InfoRow } from "../src/session-info.ts";

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

/** The node whose own `testID` is `id` (never a descendant's). */
const byId = (nodes: readonly Node[], id: string): Node | undefined => {
  for (const node of nodes) {
    if (node.props.testID === id) return node;
    const found = byId(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Every host node, flattened. */
const hosts = (nodes: readonly Node[]): Node[] =>
  nodes.flatMap((node) => [node, ...hosts(node.children)]);

describe("a row's trailing element decides whether the row is ONE element", () => {
  let row: typeof import("../src/ui/Row.tsx");
  let theme: typeof import("../src/theme.ts");
  let commands: typeof import("../src/screens/CommandsSheet.tsx");
  let sheet: typeof import("../src/screens/SessionInfoSheet.tsx");

  beforeAll(async () => {
    mock.module("react-native", () => ({
      ActivityIndicator: "ActivityIndicator",
      Image: "Image",
      Modal: "Modal",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Switch: "Switch",
      Text: "Text",
      TextInput: "TextInput",
      RefreshControl: "RefreshControl",
      View: "View",
      LayoutAnimation: { configureNext: () => {}, create: () => ({}), Types: {}, Properties: {} },
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
      useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
      AccessibilityInfo: {
        isReduceMotionEnabled: async () => false,
        addEventListener: () => ({ remove: () => {} }),
      },
    }));
    // The text seam (docs/feat/mobile-theme-beta.md) reads the app font from a
    // context; this walker calls components without React, so it is stubbed
    // to the same host strings `react-native`'s Text/TextInput are.
    mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
    mock.module("react-native-safe-area-context", () => ({
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    }));
    mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
    row = await import("../src/ui/Row.tsx");
    theme = await import("../src/theme.ts");
    commands = await import("../src/screens/CommandsSheet.tsx");
    sheet = await import("../src/screens/SessionInfoSheet.tsx");
  });

  afterAll(() => {
    mock.restore();
  });

  /** The sheet's tree for one row, with every handler recording its own call. */
  const drawCommand = (command: CommandRow): readonly Node[] =>
    walk(
      commands.CommandsSheet({
        palette: theme.lightPalette,
        rows: [command],
        onCompact: () => {},
        onStopCompact: () => {},
        onArmClear: () => {},
        onCancelClear: () => {},
        onClear: () => {},
        onRename: () => {},
        onRetry: () => {},
        onAutoAccept: () => {},
        onClose: () => {},
      }),
    );

  /** One `Row`, as the screens draw it. */
  const drawRow = (props: Record<string, unknown>): readonly Node[] =>
    walk(h(row.Row, { palette: theme.lightPalette, title: "Dictation", testID: "r", ...props }));

  const grouped = (nodes: readonly Node[]): unknown => byId(nodes, "r")?.props.accessible;
  const switchAt = (nodes: readonly Node[], id: string): Node | undefined => byId(nodes, id);

  test("a trailing VALUE is part of the row: label and value read together", () => {
    // Session info's read-only rows (`SessionInfoSheet`'s `values`): the contract
    // `rowAccessibility` documents. Treated as a control, the row stopped being
    // one element and VoiceOver read "Model" and the model id as two.
    const nodes = drawRow({
      trailing: h("Text", null, "claude-sonnet-4-5"),
      trailingKind: "value",
    });
    expect(grouped(nodes)).toBe(true);
  });

  test("a `null` trailing is no trailing at all (a ready Commands row, a switchless Tools band)", () => {
    // `edgeFor` returns `null` for every ready row; that is the ABSENCE of an
    // edge, never a control — treated as one, the row's own tap stopped being the
    // row's element (`accessible={false}`, only the label column a button).
    expect(grouped(drawRow({ trailing: null }))).toBe(true);
  });

  test("a row with no trailing at all is one element", () => {
    expect(grouped(drawRow({}))).toBe(true);
  });

  test("a trailing SWITCH is its own element, never swallowed by the row", () => {
    // The original bug: grouped, the switch was unreachable to VoiceOver AND to
    // XCUITest ("Dictation, Dictation", a disabled element).
    const nodes = drawRow({
      trailing: h("Switch", { testID: "r-switch", value: false }),
    });
    expect(grouped(nodes)).toBe(false);
    expect(switchAt(nodes, "r-switch")).toBeDefined();
  });

  test("a row with an action AND a switch keeps both: the switch its own element, the label the button", () => {
    const nodes = drawRow({
      onPress: () => {},
      trailing: h("Switch", { testID: "r-switch", value: true }),
    });
    expect(grouped(nodes)).toBe(false);
    // The action survives, on the label column.
    const button = hosts(nodes).find(
      (node) => node.props.accessible === true && node.props.accessibilityRole === "button",
    );
    expect(button?.props.accessibilityLabel).toBe("Dictation");
  });

  test("a ready Commands row is ONE element, and its tap is the row's own", () => {
    let tapped = 0;
    const nodes = walk(
      commands.CommandsSheet({
        palette: theme.lightPalette,
        rows: [{ id: "compact", label: "Compact", explain: "x", state: { kind: "ready" } }],
        onCompact: () => {
          tapped += 1;
        },
        onStopCompact: () => {},
        onArmClear: () => {},
        onCancelClear: () => {},
        onClear: () => {},
        onRename: () => {},
        onRetry: () => {},
        onAutoAccept: () => {},
        onClose: () => {},
      }),
    );
    const pressable = byId(nodes, "command-compact");
    expect(pressable?.props.accessible).toBe(true);
    (pressable?.props.onPress as () => void)();
    expect(tapped).toBe(1);
  });

  test("a dimmed row's reason is read WITH the row, not as a second element", () => {
    // `edgeFor` returns a `<Text>` reason: prose, not a control.
    const nodes = drawCommand({
      id: "compact",
      label: "Compact",
      explain: "x",
      state: { kind: "dimmed", reason: "Waits for the turn to end" },
    });
    expect(byId(nodes, "command-compact")?.props.accessible).toBe(true);
  });

  test("a running row's Stop is its own element, never swallowed", () => {
    // A control does live at this edge when the row carries one.
    const nodes = drawCommand({
      id: "compact",
      label: "Compact",
      explain: "x",
      state: { kind: "running" },
    });
    expect(byId(nodes, "command-compact")?.props.accessible).toBe(false);
    expect(byId(nodes, "command-compact-stop")).toBeDefined();
    expect(byId(nodes, "command-compact-running")?.props.children).toBeDefined();
    expect(COMPACTING).toBeDefined();
  });

  test("Auto-accept's row carries its switch as its own element", () => {
    const nodes = drawCommand({
      id: "autoAccept",
      label: "Auto-accept",
      explain: "x",
      state: { kind: "toggle", on: false },
    });
    expect(byId(nodes, "command-autoAccept")?.props.accessible).toBe(false);
    expect(byId(nodes, "command-autoAccept-switch")).toBeDefined();
  });

  describe("Session info's read-only rows keep the label + value contract", () => {
    /** The sheet over one hand-built section: its rows and nothing else. */
    const drawInfo = (rows: readonly InfoRow[]): readonly Node[] =>
      walk(
        h(sheet.SessionInfoSheet, {
          palette: theme.lightPalette,
          view: {
            subtitle: "Fix the flaky test",
            sections: [{ id: "model", title: "Model", phase: "ready", rows }],
            footer: "",
            autoAccept: false,
          },
          autoAcceptOn: false,
          autoAcceptError: null,
          onAutoAccept: () => {},
          onSwitch: () => {},
          onRefresh: () => {},
          onRetry: () => {},
          onClose: () => {},
          expanded: null,
          onExpand: () => {},
          onDeleteSchedule: () => {},
          onOpenArtifacts: () => {},
          onOpenBrowser: () => {},
        }),
      );

    test("a row with a plain value (`Model`, `claude-sonnet-4-5`) is ONE element", () => {
      // The `values` View is a READ. Counted as a control, VoiceOver read the
      // label and the value as two elements, and the row said nothing together.
      const nodes = drawInfo([{ title: "Model", value: "claude-sonnet-4-5", mono: true }]);
      expect(byId(nodes, "session-info-model-Model")?.props.accessible).toBe(true);
    });

    test("a row that shows a value AND switches is split, so the switch is reachable", () => {
      // Session info's MCP row: it opens its tools and switches the server.
      const nodes = drawInfo([
        {
          title: "demo",
          switch: {
            kind: "mcp",
            name: "demo",
            on: true,
            interactive: true,
            accessibilityLabel: "demo",
          },
        },
      ]);
      expect(byId(nodes, "session-info-model-demo")?.props.accessible).toBe(false);
      expect(byId(nodes, "session-info-model-demo-switch")).toBeDefined();
    });
  });
});
