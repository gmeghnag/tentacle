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
    expect(screen).toContain("...sheetOptions(route.params.kind,");
    expect(screen).toContain("fontScale: PixelRatio.getFontScale()");
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
