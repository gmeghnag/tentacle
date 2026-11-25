/**
 * The Commands sheet's RENDER half (docs/feat/mobile-hub-commands.md C3 item 17):
 * `session-commands.ts` decides every row's state and word, and this sheet only
 * maps it to a trailing edge. Host stubs are STRING element types
 * (`notice-row.test.ts`'s pattern: a function stub would be called and its result
 * dropped, so every assertion would pass on nothing).
 *
 * The mount is pinned from the screen's source (the `hub-commands-wiring.test.ts`
 * pattern): `SessionScreen.tsx` is a `.tsx` Bun cannot import, and C1's whole
 * dangling thread was `commandsOpen` set by nothing that read it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fragment, isValidElement } from "react";
import {
  COMPACTED_DONE,
  COMPACTING,
  type CommandRow,
  type CommandState,
} from "../src/session-commands.ts";

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

/** Every `testID` under `nodes`. */
const ids = (nodes: readonly Node[]): readonly string[] =>
  nodes.flatMap((node) => {
    const id = node.props.testID;
    return [...(typeof id === "string" ? [id] : []), ...ids(node.children)];
  });

const byId = (nodes: readonly Node[], id: string): Node | undefined => {
  for (const node of nodes) {
    if (node.props.testID === id) return node;
    const found = byId(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
};

let sheet: typeof import("../src/screens/CommandsSheet.tsx");
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
  }));
  // The text seam (docs/feat/mobile-theme-beta.md) reads the app font from a
  // context; this walker calls components without React, so it is stubbed
  // to the same host strings `react-native`'s Text/TextInput are.
  mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
  mock.module("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }));
  mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
  sheet = await import("../src/screens/CommandsSheet.tsx");
  theme = await import("../src/theme.ts");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

/** The rows `commandRows` would hand the sheet, with one row's state overridden. */
const row = (id: CommandRow["id"], state: CommandState): CommandRow => ({
  id,
  label: id === "compact" ? "Compact" : id === "clear" ? "Clear" : id,
  explain: `${id} explained`,
  state,
});

const BASE: readonly CommandRow[] = [
  row("compact", { kind: "ready" }),
  row("clear", { kind: "ready" }),
  row("rename", { kind: "ready" }),
  row("retry", { kind: "ready" }),
  row("autoAccept", { kind: "toggle", on: false }),
];

const calls: string[] = [];
const press = (what: string) => () => {
  calls.push(what);
};

/** The sheet tree for `rows`, with every handler recording its own call. */
function draw(rows: readonly CommandRow[] = BASE): readonly Node[] {
  return walk(
    sheet.CommandsSheet({
      palette: theme.lightPalette,
      rows,
      onCompact: press("compact"),
      onStopCompact: press("stop"),
      onArmClear: press("arm"),
      onCancelClear: press("cancel"),
      onClear: press("clear"),
      onRename: press("rename"),
      onRetry: press("retry"),
      onAutoAccept: press("autoAccept"),
      onClose: press("close"),
    }),
  );
}

/** Tapping the `Pressable` a testID names (its own, not a descendant's). */
function tapTestID(nodes: readonly Node[], id: string): ((...args: unknown[]) => void) | undefined {
  const target = byId(nodes, id);
  const handler = target?.props.onPress;
  return typeof handler === "function" ? (handler as (...args: unknown[]) => void) : undefined;
}

describe("the sheet is one band of rows under the hub's own words", () => {
  test("the sheet draws its title, its subtitle and one row per command", () => {
    const nodes = draw();
    expect(texts(nodes)).toContain("Commands");
    expect(texts(nodes)).toContain("What this session can do");
    expect(ids(nodes)).toContain("commands-sheet");
    for (const id of ["compact", "clear", "rename", "retry", "autoAccept"]) {
      expect(byId(nodes, `command-${id}`)).toBeDefined();
    }
    // No `Modal` of its own any more: the stack's `Sheet` route presents it
    // (docs/feat/mobile-native-sheets.md S3), and a JS modal left here would
    // wedge every later native formSheet (F6).
    expect(all(nodes, "Modal")).toHaveLength(0);
  });

  test("every row shows its one-line explanation, which the plan's mockup asks for", () => {
    const nodes = draw();
    for (const id of ["compact", "clear", "rename", "retry", "autoAccept"]) {
      expect(texts(nodes)).toContain(`${id} explained`);
    }
  });

  test("it is drawn only when on screen, so it has no `visible` prop to mount late", () => {
    // The presentation is the route's: a sheet that is not up is not mounted at
    // all. What used to be "still renders, `visible` false" is now the host's
    // `publish` (an unpublished kind draws nothing — `sheetRouteView`).
    const props = Object.keys(
      sheet.CommandsSheet({
        palette: theme.lightPalette,
        rows: BASE,
        onCompact: press("compact"),
        onStopCompact: press("stop"),
        onArmClear: press("arm"),
        onCancelClear: press("cancel"),
        onClear: press("clear"),
        onRename: press("rename"),
        onRetry: press("retry"),
        onAutoAccept: press("autoAccept"),
        onClose: press("close"),
      }).props as Record<string, unknown>,
    );
    expect(props).not.toContain("visible");
  });
});

describe("the live state is the row's TRAILING edge", () => {
  test("a running Compact renders `Compacting…` AND its Stop", () => {
    const nodes = draw([row("compact", { kind: "running" }), ...BASE.slice(1)]);
    expect(texts(nodes)).toContain(COMPACTING);
    expect(byId(nodes, "command-compact-stop")).toBeDefined();
    // A running row is not a tap target: Stop is the only way out.
    expect(tapTestID(nodes, "command-compact")).toBeUndefined();
  });

  test("a settled compaction renders `Compacted ✓` in the row (the success is quiet)", () => {
    const nodes = draw([row("compact", { kind: "done", text: COMPACTED_DONE }), ...BASE.slice(1)]);
    // The check is INSIDE the view-model's word (`COMPACTED_DONE`), so the sheet
    // draws no second glyph — one `✓`, never two.
    expect(texts(nodes)).toContain(COMPACTED_DONE);
    expect(byId(nodes, "command-compact-done")).toBeDefined();
    expect(texts(nodes).filter((text) => text === "✓")).toHaveLength(0);
  });

  test("a failure renders `▲`, its words AND a Retry that runs the command again", () => {
    const nodes = draw([
      row("compact", { kind: "failed", text: "Compact failed: nope" }),
      ...BASE.slice(1),
    ]);
    expect(texts(nodes)).toContain("▲");
    expect(texts(nodes)).toContain("Compact failed: nope");
    // The word beside the glyph: a shape alone is not spoken (the notice grammar).
    calls.length = 0;
    tapTestID(nodes, "command-compact-retry")?.();
    expect(calls).toEqual(["compact"]);
  });

  test("a dimmed row renders its reason in place, and cannot be tapped", () => {
    const nodes = draw([
      row("compact", { kind: "dimmed", reason: "Waits for the turn to end" }),
      ...BASE.slice(1),
    ]);
    expect(texts(nodes)).toContain("Waits for the turn to end");
    expect(tapTestID(nodes, "command-compact")).toBeUndefined();
    // The row is drawn `sec` (its label dimmed), not hidden: the reason IS the
    // row's answer, and the row still says what the command is.
    const label = all(nodes, "Text").find((node) => node.props.children === "Compact");
    expect((label?.props.style as readonly unknown[])[1]).toEqual({
      color: theme.lightPalette.sec,
      fontWeight: "400",
    });
  });

  test("Auto-accept's row carries the switch, wired to one setter", () => {
    const nodes = draw();
    const control = byId(nodes, "command-autoAccept-switch");
    expect(control).toBeDefined();
    expect(control?.props.value).toBe(false);
    calls.length = 0;
    (control?.props.onValueChange as (on: boolean) => void)(true);
    expect(calls).toEqual(["autoAccept"]);
  });
});

describe("Clear confirms INLINE, in its own row", () => {
  const confirming = [
    row("compact", { kind: "ready" }),
    row("clear", { kind: "confirming" }),
    ...BASE.slice(2),
  ];

  test("a `confirming` Clear asks the question in place, with Cancel and Clear", () => {
    const nodes = draw(confirming);
    expect(texts(nodes)).toContain(sheet.CLEAR_QUESTION);
    // The question replaces the row's own label — never two rows for one command.
    expect(texts(nodes)).not.toContain("clear explained twice");
    expect(byId(nodes, "command-clear-cancel")).toBeDefined();
    expect(byId(nodes, "command-clear-confirm")).toBeDefined();
    // ONE sheet: the confirm never stacks a second modal — and since
    // docs/feat/mobile-native-sheets.md S3 the one sheet is the stack's route, so
    // this file draws no `Modal` at all.
    expect(all(nodes, "Modal")).toHaveLength(0);
    // A confirming row's own tap does nothing more: the two words decide.
    expect(tapTestID(nodes, "command-clear")).toBeUndefined();
  });

  test("Cancel disarms and Clear runs — the destructive word beside the red, never hue alone", () => {
    const nodes = draw(confirming);
    calls.length = 0;
    tapTestID(nodes, "command-clear-cancel")?.();
    tapTestID(nodes, "command-clear-confirm")?.();
    expect(calls).toEqual(["cancel", "clear"]);
    const clear = byId(nodes, "command-clear-confirm");
    const label = all([clear as Node], "Text")[0];
    expect(label?.props.children).toBe("Clear");
    expect((label?.props.style as readonly unknown[])[1]).toEqual({
      color: theme.lightPalette.red,
    });
  });

  test("an unarmed Clear is a plain row that ARMS on its tap", () => {
    const nodes = draw();
    calls.length = 0;
    tapTestID(nodes, "command-clear")?.();
    expect(calls).toEqual(["arm"]);
    // Nothing to confirm yet: no destructive control exists before the tap.
    expect(byId(nodes, "command-clear-confirm")).toBeUndefined();
  });
});

describe("a ready row's own tap runs it", () => {
  test("Compact, Rename and Retry each call their own handler, once", () => {
    const nodes = draw();
    calls.length = 0;
    tapTestID(nodes, "command-compact")?.();
    tapTestID(nodes, "command-rename")?.();
    tapTestID(nodes, "command-retry")?.();
    expect(calls).toEqual(["compact", "rename", "retry"]);
    // Auto-accept's row is the switch's: its row tap does nothing.
    tapTestID(nodes, "command-autoAccept")?.();
    expect(calls).toEqual(["compact", "rename", "retry"]);
  });

  test("the close glyph closes the one sheet", () => {
    const nodes = draw();
    calls.length = 0;
    tapTestID(nodes, "commands-sheet-close")?.();
    expect(calls).toEqual(["close"]);
  });
});

describe("the screen mounts it, on the controller's own view-model", () => {
  const ROOT = join(import.meta.dir, "..");
  const SCREEN = readFileSync(join(ROOT, "src", "screens", "SessionScreen.tsx"), "utf8");

  test("`commandsOpen` is finally READ: it is what the publish block derives the stack from", () => {
    // Since docs/feat/mobile-native-sheets.md S3 the sheet is a ROUTE: the screen
    // publishes its element on `SHEET_HOSTS` and `desiredStack` decides whether a
    // route is up. `commandsOpen` is read there — the mount is no longer what
    // closes C1's no-op tap, the derived `desired` stack is.
    // (`userSheet` in `sheet-plan.ts` maps the three flags to one sheet.)
    expect(SCREEN).toContain("user: userSheet({ commands: commandsOpen,");
    const at = SCREEN.indexOf('host.publish(\n      "commands"');
    expect(at).toBeGreaterThan(-1);
    const props = SCREEN.slice(at, SCREEN.indexOf("/>,", at));
    // The rows come from `session-commands.ts`'s view-model, never built here.
    expect(props).toContain("rows={state.commands}");
    expect(props).toContain("onClose={closeCommands}");
    // No `Modal` of its own: a JS modal here would wedge the native sheet (F6).
    expect(props).not.toContain("visible=");
    expect(SCREEN).toContain("const closeCommands = () => setCommandsOpen(false);");
  });

  test("Rename closes the sheet and opens the header's ONE rename field", () => {
    const at = SCREEN.indexOf("const renameFromCommands = () => {");
    expect(at).toBeGreaterThan(-1);
    const body = SCREEN.slice(at, SCREEN.indexOf("\n  };", at));
    expect(body).toContain("setCommandsOpen(false);");
    // The field is an RN `Modal`: it opens once the native sheet is GONE
    // (docs/feat/mobile-native-sheets.md S3, `afterDismiss`), through the ONE
    // `beginRename` the header title uses.
    expect(body).toContain('queueAfterDismiss(queue, "rename")');
    const run = SCREEN.slice(SCREEN.indexOf("const runIntent"));
    expect(run.slice(0, run.indexOf("\n  };"))).toContain("controller.beginRename();");
  });

  test("it hides the floating button under itself, like every other sheet", () => {
    const at = SCREEN.indexOf("const floatShown = floatVisible({");
    const body = SCREEN.slice(at, SCREEN.indexOf("});", at));
    expect(body).toContain("commandsOpen ||");
  });

  test("every action is the controller's own — no second command path", () => {
    const at = SCREEN.indexOf('host.publish(\n      "commands"');
    const props = SCREEN.slice(at, SCREEN.indexOf("/>,", at));
    expect(props).toContain("onCompact={() => void controller.compact()}");
    expect(props).toContain("onStopCompact={() => controller.cancelCompaction()}");
    expect(props).toContain("onArmClear={() => controller.armClear()}");
    expect(props).toContain("onCancelClear={() => controller.cancelClear()}");
    expect(props).toContain("onClear={() => void controller.clear()}");
    expect(props).toContain("onRetry={() => controller.retryLast()}");
    expect(props).toContain("onAutoAccept={(on) => void controller.setAutoAccept(on)}");
  });
});
