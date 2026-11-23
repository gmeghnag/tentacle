/**
 * The native sheets' WIRING (docs/feat/mobile-native-sheets.md, slices S2–S5),
 * pinned from the source because `App.tsx`, `NativeSheetRoute.tsx` and
 * `SessionScreen.tsx` are `.tsx` (Bun cannot import them: React Native's sources
 * are Flow) — the `hub-tools-wiring.test.ts` pattern. Every DECISION is
 * `sheet-plan.test.ts`'s / `sheet-host.test.ts`'s; this file only pins that the
 * screens and the navigator use those decisions instead of re-deciding them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RootStackParams, SheetKind } from "../src/routes.ts";
import { SHEET_KINDS } from "../src/sheet-plan.ts";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const APP = code(read("App.tsx"));
const ROUTE = code(read("src", "screens", "NativeSheetRoute.tsx"));

/** A source's slice from `from` to the first `to` after it. */
const sliceOf = (src: string, from: string, to: string): string => {
  const at = src.indexOf(from);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf(to, at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
};

describe("S2 — the route table (File 3)", () => {
  test("`Sheet` carries identity + kind, and nothing that could hold content", () => {
    // The type IS the contract (routes.test.ts's pattern): a sheet's element is
    // published by the session screen, never carried in params.
    const params: RootStackParams["Sheet"] = {
      computerId: "0123456789abcdef",
      sessionId: "s1",
      kind: "tools",
    };
    expect(Object.keys(params).sort()).toEqual(["computerId", "kind", "sessionId"]);
  });

  test("the kind parameter is `sheet-plan`'s own union (no second copy)", () => {
    const first = SHEET_KINDS[0] ?? "tools";
    const params: RootStackParams["Sheet"] = { computerId: "c", sessionId: "s", kind: first };
    expect(SHEET_KINDS).toContain(params.kind as SheetKind);
    expect(SHEET_KINDS).toHaveLength(5);
  });
});

describe("S2 — the navigator (File 4)", () => {
  test("exactly ONE `Sheet` screen is declared", () => {
    expect(APP.match(/name="Sheet"/g) ?? []).toHaveLength(1);
  });

  test("its options ARE the pure table's, never a hand-written presentation", () => {
    const screen = sliceOf(APP, 'name="Sheet"', "</Stack.Screen>");
    // The detents, the initial index, the undimmed index and the grabber all come
    // from `sheetOptions` — which is what keeps RNS's dev asserts unreachable.
    expect(screen).toContain("...sheetOptions(\n                route.params.kind,");
    // S3: the context is the remembered detent + Dynamic Type (D3).
    expect(screen).toContain("PixelRatio.getFontScale(),");
    // Nothing may restate the presentation in the navigator: a second source of
    // truth here is exactly how the sheet loses its detents.
    expect(screen).not.toContain('presentation: "formSheet"');
    expect(screen).not.toContain("sheetAllowedDetents");
  });

  test("the route's ground is the palette token the pure module names", () => {
    const screen = sliceOf(APP, 'name="Sheet"', "</Stack.Screen>");
    expect(screen).toContain("backgroundColor: palette[sheetGround(route.params.kind)]");
  });

  test("it renders the route with the session's identity and its kind", () => {
    const screen = sliceOf(APP, 'name="Sheet"', "</Stack.Screen>");
    expect(screen).toContain("<NativeSheetRoute");
    expect(screen).toContain("computerId={route.params.computerId}");
    expect(screen).toContain("sessionId={route.params.sessionId}");
    expect(screen).toContain("kind={route.params.kind}");
  });

  test("it closes with a keyed pop, NEVER `goBack()` (that pops Session itself)", () => {
    const screen = sliceOf(APP, 'name="Sheet"', "</Stack.Screen>");
    // The screen's own navigation dispatches with `source: route.key`, so `pop`
    // removes THIS route only (StackRouter `POP` keyed on source).
    expect(screen).toContain("onClose={() => navigation.pop()}");
    expect(screen).not.toContain("goBack(");
  });
});

describe("S2 — the pure module stays OUT of react-native's types", () => {
  test("`sheet-plan.ts` imports no RN / navigation module", () => {
    // A type-only import is not harmless: `@react-navigation/native-stack` pulls
    // `react-native`, whose `src/types/globals.d.ts` `declare global`s
    // `setInterval(...): number`. `scripts/mockup-kit/sources.ts` imports
    // `drawer-nav.ts` → `routes.ts` → here, so that ambient global enters the
    // ROOT `tsc --noEmit` program and retypes every timer in the monorepo —
    // seven `setInterval/setTimeout(...).unref()` sites in cli/exec/docker/k8s/
    // daemon stop compiling. The option shape is declared locally instead.
    const plan = read("src", "sheet-plan.ts");
    expect(plan).not.toContain('from "react-native"');
    expect(plan).not.toContain('from "@react-navigation/');
    // The safety net: if RNS renames an option, the App.tsx spread (checked by
    // `tsc -p apps/mobile`) is what catches it — but the harness asserts here too.
    expect(plan).toContain("export interface SheetNavigationOptions");
  });
});

describe("S2 — the route component (File 5)", () => {
  test("it reads the published content through the host, keyed on the session", () => {
    expect(ROUTE).toContain("SHEET_HOSTS.host(computerId, sessionId)");
    expect(ROUTE).toContain("useSyncExternalStore(host.subscribe, () => host.snapshot(kind))");
  });

  test("its ONE branch is the pure module's (`sheetRouteView`), not local ifs", () => {
    expect(ROUTE).toContain("sheetRouteView(snapshot)");
    // No empty sheet is ever drawn: anything but `draw` renders nothing.
    expect(ROUTE).toContain('if (view !== "draw")');
  });

  test("its close is the keyed pop the screen handed it, never `goBack()`", () => {
    expect(ROUTE).toContain("onClose()");
    expect(ROUTE).not.toContain("goBack(");
    expect(ROUTE).not.toContain("navigation.");
  });
});

describe("S3 — the reconciler is the pure module's, and the screen only dispatches", () => {
  const SCREEN = code(read("src", "screens", "SessionScreen.tsx"));

  test("the wanted stack is `desiredStack` → `managedStack`, never a local if-chain", () => {
    expect(SCREEN).toContain("desiredStack({");
    expect(SCREEN).toContain("managedStack(desired, PRESENTED_SHEET_KINDS)");
    // The loop's dependency is stable between renders (keyed on the content).
    expect(SCREEN).toContain("useMemo(() => wantedNow, [wantedKey])");
  });

  test("the session identity is memoized (else `forget` would run on every render)", () => {
    expect(SCREEN).toMatch(/const owner = useMemo\(/);
    expect(SCREEN).toContain("[computerId, sessionId],");
  });

  test("a push is gated on `inFront`, not the raw flag its own sheet blurs", () => {
    expect(SCREEN).toContain("if (!inFront) {\n      return;\n    }\n    openSheet(");
    expect(SCREEN).not.toContain("focusedNow");
  });

  test("a planned pop is spent only once it landed (a drain spans several states)", () => {
    expect(SCREEN).toContain(
      "plannedPop.current = plannedPop.current.filter((key) => still.has(key))",
    );
    expect(SCREEN).not.toContain("plannedPop.current = [];");
  });

  test("Commands → Rename waits for the route to go (`afterDismiss`, F6b)", () => {
    expect(SCREEN).toContain('setAfterDismiss((queue) => queueAfterDismiss(queue, "rename"))');
    const rename = SCREEN.slice(SCREEN.indexOf("const renameFromCommands"));
    expect(rename.slice(0, rename.indexOf("};"))).not.toContain("beginRename");
  });

  test("App.tsx opens a sheet at its remembered detent and records stable changes", () => {
    const shell = code(APP);
    expect(shell).toContain("sheetDetentContext(");
    expect(shell).toContain("sheetDetentChange: (event) =>");
    expect(shell).toContain("recordDetent(");
  });

  test("one step per pass: `reconcile` decides push/pop, `drainPops` empties the stack", () => {
    expect(SCREEN).toContain("reconcile(wanted, actual,");
    expect(SCREEN).toContain("drainPops(actual)");
    // The drain runs EVERY key in one pass (Owner decision A, Step 0b L1).
    expect(SCREEN).toContain("for (const key of keys) {");
  });

  test("the drain's trigger is `sheetHidden(locked, AppState)`, and nothing pushes while hidden", () => {
    expect(SCREEN).toContain("sheetHidden(locked, appActivityState)");
    expect(SCREEN).toContain("appActivity(AppState.currentState)");
    // `locked` is a props value subscribed in App.tsx — never `lock.view()` here.
    expect(SCREEN).not.toContain(".view().locked");
    expect(SCREEN).not.toContain("lockInstance");
  });

  test("a sheet is opened with `push` and closed with a KEYED pop (never `goBack`)", () => {
    expect(SCREEN).toContain("openSheet(navigation, { ...owner, kind: step.kind })");
    expect(SCREEN).toContain("popSheet(navigation, step.key)");
    expect(SCREEN).not.toContain("goBack(");
  });

  test("a native swipe is read back as that kind's OWN close handler", () => {
    expect(SCREEN).toContain("dismissedNatively(lastActual.current, actual, plannedPop.current)");
    expect(SCREEN).toContain(
      '      setCommandsOpen(false);\n    }\n    if (gone.includes("outbox"))',
    );
    expect(SCREEN).toContain("setDeciding(null)");
  });

  test("the stack is read through a stable selector, and scoped to THIS session", () => {
    expect(SCREEN).toContain("useNavigationState((state) =>");
    expect(SCREEN).toContain("stackSignature(state.routes as readonly SheetRouteLike[])");
    expect(SCREEN).toContain("sheetsOfSession(rootRoutes, owner)");
  });

  test("the voice gates read `sessionInFront`, not the raw blur-able flag", () => {
    expect(SCREEN).toContain("sessionInFront(focused, sheetStack)");
    expect(SCREEN).toContain("focused: inFront");
    expect(SCREEN).toContain("askSeq, inFront)");
  });

  test("a foreign RN Modal yields while a sheet is up or coming (F6)", () => {
    expect(SCREEN).toContain("yieldForeign(wanted, actual)");
    for (const prop of ["hubMenu !== null && !yields", "menuOpen && !yields"]) {
      expect(SCREEN).toContain(prop);
    }
    expect(SCREEN).toContain("activityOpen && !yields");
    // Rename's text survives in the controller, so hiding it loses nothing.
    expect(SCREEN).toContain("state={yields ? null : renaming}");
  });

  test("the content is PUBLISHED, and the host is forgotten on unmount (the orphan pop)", () => {
    expect(SCREEN).toContain("SHEET_HOSTS.host(owner.computerId, owner.sessionId)");
    expect(SCREEN).toContain('host.publish(\n      "commands"');
    expect(SCREEN).toContain('host.publish(\n      "outbox"');
    expect(SCREEN).toContain("SHEET_HOSTS.forget(at.computerId, at.sessionId)");
  });

  test("the two migrated sheets are no longer mounted in the JSX", () => {
    // A `<Modal>` here would wedge the native sheet (F6) and draw a second copy.
    expect(SCREEN.match(/<CommandsSheet/g) ?? []).toHaveLength(1);
    expect(SCREEN.match(/<OutboxDecisionSheet/g) ?? []).toHaveLength(1);
    expect(SCREEN).not.toContain("visible={commandsOpen}");
  });

  test("App.tsx passes the session's identity and the lock's SUBSCRIBED value", () => {
    expect(APP).toContain(
      "computerId={computerId}\n      sessionId={sessionId}\n      locked={locked}",
    );
    const shell = code(APP);
    expect(shell).toContain("lockInstance.subscribe((view) => setSheetLocked(view.locked))");
    expect(shell).toContain("locked={sheetLocked}");
    // The drain must never read the render-time `lockView` (stale, Step 0b).
    expect(shell).not.toContain("locked={lockView.locked}");
  });
});
