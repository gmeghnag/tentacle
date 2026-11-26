/**
 * The SCHEDULED WAKES band and the reveal's measuring seam, RENDERED
 * (docs/feat/mobile-hub.md H4a).
 *
 * `session-info.test.ts` proves the view-model (`schedulesSection`'s rows, their
 * titles, their RAW delete ids); `session-info-reveal.test.ts` proves the reveal's
 * rule (`scheduledSection`/`revealStep`). Neither proves the SHEET draws them: a
 * row the view-model carries but `SectionBody` never places, or a `testID` built
 * from the title instead of the identity, passes both of those and fails here.
 *
 * So this file renders the real element tree of `SessionInfoSheet` (no renderer:
 * the `.tsx` components are called and the returned elements walked — the pattern
 * `band-notes.test.ts` set, which needs only React itself) and asserts:
 *  - the wakes band's rows are host nodes with `session-info-schedules-<id>` and
 *    `session-info-schedules-<id>-delete`, and the delete sends the wake's RAW id;
 *  - every section reports its y through `onSectionLayout`, in the view's order —
 *    the seam the reveal scrolls on (a sheet that never reports leaves the hub's
 *    Scheduled item at the top of the sheet, silently).
 *
 * `react-native`/`expo-symbols`/`react-native-safe-area-context` are mocked to
 * host stubs (string element types, so the walker keeps them as nodes — a
 * function stub would be called and its result discarded, and every assertion
 * below would pass on an empty tree). Bun cannot load React Native's Flow
 * sources. `band-notes.test.ts` mocks the same three specifiers; the mock is
 * process-wide (`mock.module` has no per-file scope), so each file installs its
 * own stubs in `beforeAll` and restores in `afterAll`, and the two are run
 * together to keep that honest.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ScheduleRow } from "@tentacle/protocol";
import { Fragment, createElement as h, isValidElement } from "react";
import type { InfoFacts, SectionId, SessionInfoView } from "../src/session-info.ts";

/** One node of the walked element tree: a host stub, or something unexpected. */
interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

/** The clock the rows' distances are worded against (injected, never the wall's). */
const NOW = 1_700_000_000_000;

const WAKE: ScheduleRow = {
  id: "sc-1",
  kind: "every",
  spec: "every 10m",
  prompt: "check CI on PR #412",
  nextAt: NOW + 600_000,
  fires: 4,
  createdAt: 1,
};

describe("`SessionInfoSheet` renders the wakes band, and measures every single band (H4a)", () => {
  let sheet: typeof import("../src/screens/SessionInfoSheet.tsx");
  let info: typeof import("../src/session-info.ts");
  let theme: typeof import("../src/theme.ts");
  let scheduleView: typeof import("../src/schedule-view.ts");

  beforeAll(async () => {
    mock.module("react-native", () => ({
      Modal: "Modal",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Switch: "Switch",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
      useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
    }));
    // The text seam (docs/feat/mobile-theme-beta.md) reads the app font from a
    // context; this walker calls components without React, so it is stubbed
    // to the same host strings `react-native`'s Text/TextInput are.
    mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
    mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
    mock.module("react-native-safe-area-context", () => ({
      useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    }));
    sheet = await import("../src/screens/SessionInfoSheet.tsx");
    info = await import("../src/session-info.ts");
    theme = await import("../src/theme.ts");
    scheduleView = await import("../src/schedule-view.ts");
  });

  afterAll(() => {
    mock.restore();
  });

  /** Walk the element tree: call every component, keep the host stubs. */
  const walk = (element: unknown, out: Node[] = []): Node[] => {
    if (element === null || element === undefined || typeof element === "boolean") {
      return out;
    }
    if (Array.isArray(element)) {
      for (const child of element) {
        walk(child, out);
      }
      return out;
    }
    if (!isValidElement(element)) {
      return out;
    }
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

  /** A node's text, flattening nested runs exactly as a text parent would. */
  const textOf = (node: Node): string => {
    const flat = (value: unknown): string => {
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
      if (Array.isArray(value)) {
        return value.map(flat).join("");
      }
      if (isValidElement(value)) {
        return flat((value as { props: Record<string, unknown> }).props.children);
      }
      return "";
    };
    return flat(node.props.children);
  };

  /** The facts the controller gathers, with the wakes feed wired. */
  const facts = (over: Partial<InfoFacts> = {}): InfoFacts =>
    ({
      phase: "open",
      link: "up",
      title: "Fix the flaky test",
      computerName: "MacBook Pro",
      daemon: { version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 },
      mcp: { state: "ready", value: { servers: [] } },
      skills: { state: "ready", value: { slash: [], skills: [], problems: [], moreProblems: 0 } },
      context: { state: "ready", value: { used: 0, exact: true } },
      entry: {
        state: "ready",
        value: {
          sessionId: "s-1",
          title: "Fix the flaky test",
          cwd: "/Users/me/tentacle/apps",
          createdAt: 0,
          updatedAt: 0,
          running: false,
          attached: 1,
          archived: false,
        },
      },
      autoAccept: false,
      now: NOW,
      ...over,
    }) as InfoFacts;

  interface Rendered {
    readonly tree: Node[];
    readonly view: SessionInfoView;
    readonly deleted: string[];
  }

  /** The sheet's host tree, plus what its delete control sent. */
  const renderSheet = (
    over: Partial<InfoFacts> = {},
    onLayout?: (id: SectionId, y: number) => void,
  ): Rendered => {
    const view = info.sessionInfoView(facts(over));
    const deleted: string[] = [];
    const tree = walk(
      h(sheet.SessionInfoSheet, {
        palette: theme.darkPalette,
        view,
        autoAcceptOn: false,
        autoAcceptError: null,
        onAutoAccept: () => {},
        onSwitch: () => {},
        onRefresh: () => {},
        onRetry: () => {},
        onClose: () => {},
        expanded: null,
        onExpand: () => {},
        onDeleteSchedule: (id: string) => {
          deleted.push(id);
        },
        onOpenArtifacts: () => {},
        onOpenBrowser: () => {},
        ...(onLayout === undefined ? {} : { onSectionLayout: onLayout }),
      }),
    );
    return { tree, view, deleted };
  };

  const hosts = (tree: Node[]): Node[] => tree.flatMap((node) => [node, ...hosts(node.children)]);

  test("the wakes band's rows are real views, keyed by the wake's IDENTITY", () => {
    const { tree, view } = renderSheet({
      schedules: { rows: [WAKE], error: null },
    });
    // The walk must actually see the sheet, or everything below is vacuous.
    expect(hosts(tree).some((node) => node.props.testID === "session-info-scroll")).toBe(true);
    const band = view.sections.find((section) => section.id === "schedules");
    if (band === undefined) {
      throw new Error("the wakes band must be drawn when the feed is wired");
    }
    expect(band.rows.map((row) => info.rowIdentity(row))).toEqual(["sc-1"]);

    const all = hosts(tree);
    const row = all.filter((node) => node.props.testID === "session-info-schedules-sc-1");
    // Exactly one row view, holding the wake's own title (its sanitized prompt).
    expect(row.map((node) => textOf(node).includes("check CI on PR #412"))).toEqual([true]);
    // …and its Delete, a real view a flow can tap, carrying the wake's own label.
    const remove = all.filter((node) => node.props.testID === "session-info-schedules-sc-1-delete");
    expect(remove.map((node) => node.type)).toEqual(["Pressable"]);
    expect(remove.map((node) => node.props.accessibilityLabel)).toEqual([
      'Delete the scheduled wake "check CI on PR #412"',
    ]);
    // No switch on a wake: a wake has no on/off, only a delete (cron-tool S6).
    expect(all.some((node) => node.props.testID === "session-info-schedules-sc-1-switch")).toBe(
      false,
    );
  });

  test("the delete sends the wake's RAW id, not its (bounded) row key", () => {
    // A wake whose id is longer than `scheduleIdLabel`'s 24-char bound, so the
    // ROW KEY (the truncated label) and the WIRE ID differ. A control that sent
    // the key would look right on screen and delete nothing on the daemon.
    const long: ScheduleRow = { ...WAKE, id: "sc-0123456789abcdef0123456789abcdef" };
    const { tree, deleted } = renderSheet({ schedules: { rows: [long], error: null } });
    // The row's testID rides its KEY (bounded), so the two cannot be confused.
    const key = scheduleView.keyedScheduleRows([long])[0]?.key ?? "";
    expect(key).not.toBe(long.id);
    const remove = hosts(tree).filter(
      (node) => node.props.testID === `session-info-schedules-${key}-delete`,
    );
    const press = remove[0]?.props.onPress;
    if (typeof press !== "function") {
      throw new Error("the delete control must be pressable");
    }
    (press as () => void)();
    // The title is a sanitized label; the id is what the daemon knows the wake by.
    expect(deleted).toEqual(["sc-0123456789abcdef0123456789abcdef"]);
  });

  test("an older daemon's missing table is drawn as its own band, never as rows", () => {
    // `rows: undefined` is "no table reported" (an older daemon): `unsupported`,
    // whose honest empty row is the band's only content (P6/M9).
    const { tree } = renderSheet({ schedules: { rows: undefined, error: null } });
    const empty = hosts(tree).filter(
      (node) => node.props.testID === "session-info-empty-schedules",
    );
    expect(empty.map((node) => textOf(node).includes("update tentacle"))).toEqual([true]);
    expect(
      hosts(tree).some((node) => {
        const id = node.props.testID;
        return typeof id === "string" && id.startsWith("session-info-schedules-");
      }),
    ).toBe(false);
  });

  test("every band reports its y through `onSectionLayout`, in the view's order", () => {
    // The seam the reveal scrolls on. A sheet that drops it leaves the hub's
    // Scheduled item at the top of the sheet — silently, with nothing failing.
    const laid: { id: SectionId; y: number }[] = [];
    const { tree, view } = renderSheet({ schedules: { rows: [WAKE], error: null } }, (id, y) => {
      laid.push({ id, y });
    });
    const willing = hosts(tree).filter((node) => typeof node.props.onLayout === "function");
    // One measuring view per drawn band, and the wakes one is among them.
    expect(willing.length).toBe(view.sections.length);
    expect(view.sections.some((section) => section.id === "schedules")).toBe(true);
    // Laying each out (distinct y, in tree order) reports THAT band's y.
    willing.forEach((node, index) => {
      (node.props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { y: (index + 1) * 100 } },
      });
    });
    expect(laid).toEqual(
      view.sections.map((section, index) => ({ id: section.id, y: (index + 1) * 100 })),
    );
  });

  test("without the seam the sheet draws no measuring view at all", () => {
    // Non-vacuity for the test above: the `onLayout` props come from the optional
    // prop, not from something the sheet attaches unconditionally.
    const { tree } = renderSheet({ schedules: { rows: [WAKE], error: null } });
    expect(hosts(tree).filter((node) => typeof node.props.onLayout === "function")).toEqual([]);
  });

  test("the scroll view is handed the caller's own ref (the reveal's target)", () => {
    const seen: unknown[] = [];
    const onRef = (node: unknown): void => {
      seen.push(node);
    };
    const view = info.sessionInfoView(facts({ schedules: { rows: [WAKE], error: null } }));
    const tree = walk(
      h(sheet.SessionInfoSheet, {
        palette: theme.darkPalette,
        view,
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
        scrollRef: onRef,
      }),
    );
    const scroller = hosts(tree).filter((node) => node.props.testID === "session-info-scroll");
    // The caller's callback rides on the ScrollView itself, so a reveal scrolls
    // the real scroller (a wrapper that dropped the node would scroll nothing).
    expect(scroller.map((node) => node.props.ref === onRef)).toEqual([true]);
    // React Native calls it with the node and later with null (unmount) — the
    // callback contract the screen's `infoScroller` ref relies on.
    const mounted = { scrollTo: () => {} };
    (scroller[0]?.props.ref as (node: unknown) => void)(mounted);
    (scroller[0]?.props.ref as (node: unknown) => void)(null);
    expect(seen).toEqual([mounted, null]);
  });
});
