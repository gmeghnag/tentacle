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
const SCREEN = code(read("src", "screens", "SessionScreen.tsx"));
const UI_SHEET = read("src", "ui", "Sheet.tsx");
const TOOLS = code(read("src", "screens", "ToolsSheet.tsx"));
const INFO = code(read("src", "screens", "SessionInfoSheet.tsx"));

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
    expect(SCREEN).toContain("openSheet(navigation, {");
    expect(SCREEN).toContain("kind: step.kind,");
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

/** A component's own JSX slice: from `export function Name(` to the next `export `. */
const bodyOf = (src: string, name: string): string => {
  const at = src.indexOf(`export function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("\nexport ", at);
  return src.slice(at, end === -1 ? undefined : end);
};

describe("S4 — neither migrated sheet draws a Modal any more", () => {
  test("no `<Modal>` and no `visible` prop in Tools or Session info", () => {
    // A `<Modal>` here would wedge the native sheet (F6) and draw a second copy of
    // the same content over it.
    for (const sheet of [TOOLS, INFO]) {
      expect(sheet).not.toContain("<Modal");
      expect(sheet).not.toMatch(/readonly visible: boolean/);
      expect(sheet).not.toContain("visible=");
    }
  });

  test("neither imports `Modal` from react-native either (an unused import is a plan to return)", () => {
    for (const sheet of [TOOLS, INFO]) {
      expect(sheet).not.toMatch(/\bModal,/);
    }
  });

  test("neither is mounted in the screen's JSX any more: it is PUBLISHED", () => {
    // A mounted copy draws a second sheet under the route, and its empty route
    // (nothing published) would pop itself.
    expect(SCREEN.match(/<ToolsSheet/g) ?? []).toHaveLength(1);
    expect(SCREEN.match(/<SessionInfoSheet/g) ?? []).toHaveLength(1);
    expect(SCREEN).toMatch(/host\.publish\(\s*"tools"/);
    expect(SCREEN).toMatch(/host\.publish\(\s*"info"/);
    expect(SCREEN).not.toContain("visible={toolsOpen}");
    expect(SCREEN).not.toContain("visible={infoOpen}");
  });
});

describe("S4 — `Sheet`'s `native` variant (D4)", () => {
  test("it is a prop, defaulting to false so every other caller is unchanged", () => {
    // `PairScreen`'s floating card is the one other caller; a default of true
    // would strip its drawn grabber and its top radius silently.
    expect(UI_SHEET).toMatch(/readonly native\?: boolean;/);
    expect(UI_SHEET).toMatch(/\n\s+native = false,/);
  });

  test("it drops the DRAWN grabber, because the native one replaces it", () => {
    // The native control draws the grabber; a second one is two grabbers.
    expect(UI_SHEET).toMatch(/native \? null : \(\n\s*<View style=\{\[styles\.grabber/);
  });

  test("it drops the top radius: UIKit's corner is the sheet's own", () => {
    // Two radii on one corner is a visible seam at the top of the sheet.
    expect(UI_SHEET).toContain("borderTopLeftRadius: native ? 0 : radius.sheet");
    expect(UI_SHEET).toContain("borderTopRightRadius: native ? 0 : radius.sheet");
  });

  test("`scroll` pins the head and leaves ONE inner scroller (F8, no nesting)", () => {
    // The head (title, subtitle, close) is OUTSIDE the scroller and the body is
    // inside it: with the head inside too, a scroll drags the title away, and the
    // two nested scrollers are what fails to expand the sheet to L.
    const scroll = UI_SHEET.slice(UI_SHEET.indexOf("if (scroll) {"));
    // The scroller's own tag comes after the head is BUILT and before the
    // children are placed in it (the head is a variable, so the order is read
    // from where each is declared/used).
    const head = scroll.indexOf("const head = (");
    const scroller = scroll.indexOf("const scroller = (");
    expect(head).toBeGreaterThan(-1);
    expect(scroller).toBeGreaterThan(head);
    expect(scroll).toContain("{head}");
    expect(scroll).toContain("{children}");
    // The native variant returns the TWO direct children F0 requires, in order.
    expect(scroll).toMatch(/if \(native\) \{[\s\S]*\{head\}\s*\{scroller\}/);
  });
});

describe("S4 — Tools and Session info hand their list to `Sheet`'s ONE scroller", () => {
  for (const [name, sheet] of [
    ["Tools", TOOLS],
    ["Session info", INFO],
  ] as const) {
    test(`${name}: \`Sheet\` is asked for the native variant`, () => {
      expect(bodyOf(sheet, name === "Tools" ? "ToolsSheet" : "SessionInfoSheet")).toMatch(
        /\n\s+native\n/,
      );
    });
  }

  test("Tools' list is the sheet's scroller, not a second ScrollView", () => {
    // `Sheet scroll` + an inner list is exactly F8's nesting. The list is passed
    // as the sheet's children, so there is ONE scroller and scroll-to-expand
    // reaches the sheet's edge (Step 0's F8: nested stays at M).
    const body = bodyOf(TOOLS, "ToolsSheet");
    expect(body).not.toContain("<ScrollView");
    // The pinned head + one scroller shape is ASKED FOR, not inherited from
    // `Sheet`'s default (which is the flat sheet).
    expect(body).toMatch(/\n\s+scroll\n/);
    expect(body).toMatch(/\n\s+native\n/);
    // The pull-to-refresh and the keyboard contract ride the ONE scroller now.
    expect(body).toContain('scrollTestID="tools-scroll"');
    expect(body).toContain("refreshControl={");
    // The keyboard contract is the scroller's, and the scroller is `Sheet`'s.
    expect(UI_SHEET).toContain('keyboardShouldPersistTaps="handled"');
  });

  test("Session info's list is the sheet's scroller, and the reveal still rides it", () => {
    const body = bodyOf(INFO, "SessionInfoSheet");
    expect(body).not.toContain("<ScrollView");
    // The reveal's ref + the measuring band are `Sheet`'s scroller's now: a
    // wrapper that dropped them would scroll nothing (H4a) and never report a y.
    expect(body).toContain("scrollRef === undefined ? {} : { scrollRef }");
    expect(body).toContain("onSectionLayout(section.id, event.nativeEvent.layout.y)");
    expect(body).toContain('scrollTestID="session-info-scroll"');
  });
});

describe("S4 — Session info opens at L when it was opened with a reveal", () => {
  test("the screen states the reveal, and the route resolves the detent", () => {
    // The tracker lives in the screen (`reveal-report.ts`), so the screen states
    // the fact on the route's params and `sheetDetentContext` decides the detent.
    expect(SCREEN).toContain('...(step.kind === "info" && revealWanted ? { reveal: true } : {})');
    expect(APP).toContain("route.params.reveal === true,");
  });

  test("App.tsx resolves the opening context from the route's params", () => {
    // The route's options are resolved before the route's screen mounts, so the
    // context comes from the PARAMS the screen published.
    expect(code(APP)).toContain("route.params.reveal === true,");
    expect(code(APP)).toContain("sheetDetentContext(");
  });
});

describe("S4 — Session info's Artifacts row waits for the route to go (F6b)", () => {
  test("it is QUEUED, and never opens the gallery under the sheet", () => {
    // The gallery is a `push` — a second presentation while the sheet is up
    // (F6a/b). Its own close is not the path either: the route must be gone.
    expect(SCREEN).toContain('setAfterDismiss((queue) => queueAfterDismiss(queue, "artifacts"))');
    const open = SCREEN.slice(SCREEN.indexOf("const openArtifactsFromInfo"));
    expect(open.slice(0, open.indexOf("};"))).not.toContain("onOpenArtifacts?.(");
  });

  test("the intent runs the gallery's own one entry once the route is gone", () => {
    const run = SCREEN.slice(SCREEN.indexOf("const runIntent = (intent: AfterDismissIntent) => {"));
    expect(run.slice(0, run.indexOf("\n  };"))).toContain('onOpenArtifacts("session-info")');
  });
});

describe("S4 — a native swipe of Tools or Session info runs that sheet's own close", () => {
  test("`closeTools` and the info close are the handlers a swipe reaches", () => {
    const gone = SCREEN.slice(SCREEN.indexOf("const gone = dismissedNatively("));
    const body = gone.slice(0, gone.indexOf("}, [actual]);"));
    expect(body).toContain('gone.includes("tools")');
    expect(body).toContain("closeToolsSheetOnly()");
    expect(body).toContain('gone.includes("info")');
    expect(body).toContain("closeInfoSheetOnly()");
  });

  test("the close body is ONE function, shared by the glyph and the swipe", () => {
    // Two copies of "unset the flag, clear the expansion, tell the controller"
    // drift: the glyph would clear the controller and a swipe would not.
    expect(SCREEN).toContain("const closeInfoSheetOnly = useCallback(() => {");
    expect(SCREEN.match(/controller\.closeInfo\(\)/g) ?? []).toHaveLength(2);
  });
});
