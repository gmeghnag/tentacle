/**
 * The Browser page, the risk strip and the Session info row, RENDERED
 * (docs/feat/browser-inspect.md B6b): no renderer — the `.tsx` components are
 * called and the returned elements walked (`session-info-schedules-render`'s
 * pattern). `SessionScreen.tsx` cannot be rendered here, so how it joins them is
 * read from its source.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_GROUPS } from "@tentacle/core";
import type { SessionCapabilitiesWire } from "@tentacle/protocol";
import { Fragment, createElement as h, isValidElement } from "react";

interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

const walk = (element: unknown, out: Node[] = []): Node[] => {
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
    return walk(props.children, out);
  }
  if (typeof type === "function") {
    return walk((type as (p: Record<string, unknown>) => unknown)(props), out);
  }
  const node: Node = { type, props, children: [] };
  out.push(node);
  walk(props.children, node.children);
  return out;
};

const hosts = (tree: Node[]): Node[] => tree.flatMap((node) => [node, ...hosts(node.children)]);
const byId = (tree: Node[], id: string) => hosts(tree).find((node) => node.props.testID === id);

/** Every string drawn under `node`. */
const textOf = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("");
  }
  if (isValidElement(value)) {
    return textOf((value as { props: Record<string, unknown> }).props.children);
  }
  return "";
};
const drawn = (tree: Node[]) =>
  hosts(tree)
    .filter((node) => node.type === "Text")
    .map((node) => textOf(node.props.children))
    .join("\n");

const caps = (off: readonly string[] = []): SessionCapabilitiesWire => ({
  disabledMcp: [],
  disabledSkills: [],
  disabledTools: [...off],
  browser: { enabled: off.length === 0, actions: "auto", secrets: "masked" },
});
const OFF: readonly string[] = TOOL_GROUPS.browser ?? [];

describe("the browser surfaces, rendered", () => {
  let page: typeof import("../src/screens/BrowserPage.tsx");
  let strip: typeof import("../src/ui/RiskStrip.tsx");
  let sheet: typeof import("../src/screens/SessionInfoSheet.tsx");
  let view: typeof import("../src/browser-view.ts");
  let info: typeof import("../src/session-info.ts");
  let theme: typeof import("../src/theme.ts");

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
    mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
    mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
    mock.module("react-native-safe-area-context", () => ({
      useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    }));
    page = await import("../src/screens/BrowserPage.tsx");
    strip = await import("../src/ui/RiskStrip.tsx");
    sheet = await import("../src/screens/SessionInfoSheet.tsx");
    view = await import("../src/browser-view.ts");
    info = await import("../src/session-info.ts");
    theme = await import("../src/theme.ts");
  });

  afterAll(() => {
    mock.restore();
  });

  function renderPage(off: readonly string[] = []) {
    const sent: [string, string, boolean][] = [];
    const calls = { back: 0, locked: 0 };
    const tree = walk(
      h(page.BrowserPage, {
        palette: theme.darkPalette,
        view: view.browserPageView({
          caps: caps(off),
          phase: "on",
          status: {
            available: true,
            link: { state: "connected", managed: false },
            tabs: [{ id: 7, title: "CI run", where: "x.com", handedOver: false, traced: false }],
          },
          title: "Fix CI",
          computerName: "mac",
          error: null,
        }),
        onBack: () => {
          calls.back += 1;
        },
        onClose: () => {},
        onSwitch: (kind, name, enabled) => {
          sent.push([kind, name, enabled]);
        },
        onLockedTap: () => {
          calls.locked += 1;
        },
      }),
    );
    return { tree, sent, calls };
  }

  const press = (node: Node | undefined) => (node?.props.onPress as (() => void) | undefined)?.();
  const flip = (node: Node | undefined, on: boolean) =>
    (node?.props.onValueChange as ((on: boolean) => void) | undefined)?.(on);

  test("the page draws the link, the three switches and the tabs", () => {
    const { tree } = renderPage();
    const text = drawn(tree);
    for (const expected of [
      "Browser",
      "‹ Session info",
      "Chrome",
      "Link",
      "◉ connected",
      "This session",
      "Browser tools",
      "Act without asking",
      "Show secrets",
      "Tabs · tentacle · Fix CI",
      "CI run",
      "Opened by the agent",
    ]) {
      expect(text).toContain(expected);
    }
    // The switch shows the daemon's value.
    expect(byId(tree, "browser-page-auto-switch")?.props.value).toBe(true);
    expect(byId(tree, "browser-page-clear-switch")?.props.value).toBe(false);
  });

  test("each switch sends its own kind and name; back goes back", () => {
    const { tree, sent, calls } = renderPage();
    flip(byId(tree, "browser-page-tools-switch"), false);
    flip(byId(tree, "browser-page-auto-switch"), false);
    flip(byId(tree, "browser-page-clear-switch"), true);
    expect(sent).toEqual([
      ["tool", "browser", false],
      ["browser", "auto", false],
      ["browser", "clear", true],
    ]);
    press(byId(tree, "browser-page-back"));
    expect(calls.back).toBe(1);
  });

  test("locked: dimmed switch, the label, and a tap answers (haptic) without sending", () => {
    const { tree, sent, calls } = renderPage(OFF);
    expect(byId(tree, "browser-page-auto-switch")?.props.disabled).toBe(true);
    expect(byId(tree, "browser-page-tools-switch")?.props.disabled).toBe(false);
    expect(drawn(tree)).toContain("Browser tools off");
    press(byId(tree, "browser-page-auto"));
    press(byId(tree, "browser-page-clear"));
    expect(calls.locked).toBe(2);
    expect(sent).toEqual([]);
    // An unlocked row has no tap of its own.
    expect(byId(renderPage().tree, "browser-page-auto")?.props.onPress).toBeUndefined();
  });

  test("the strip says the words with a glyph, and Change › opens the page", () => {
    let changed = 0;
    const tree = walk(
      h(strip.RiskStrip, {
        palette: theme.darkPalette,
        items: ["Secrets visible", "Browser acts alone"],
        onChange: () => {
          changed += 1;
        },
      }),
    );
    expect(drawn(tree)).toContain("▲ Secrets visible · Browser acts alone");
    expect(drawn(tree)).toContain("Change ›");
    press(byId(tree, "risk-strip-change"));
    expect(changed).toBe(1);
  });

  test("Session info's Browser row opens the page", () => {
    let opened = 0;
    const tree = walk(
      h(sheet.SessionInfoSheet, {
        palette: theme.darkPalette,
        view: info.sessionInfoView({
          phase: "open",
          link: "up",
          title: "t",
          computerName: "mac",
          daemon: undefined,
          mcp: { state: "loading" },
          skills: { state: "loading" },
          context: { state: "loading" },
          entry: { state: "ready", value: null },
          autoAccept: false,
          capabilities: { phase: "on", state: caps(), changedBy: {}, error: null },
          now: 1,
        }),
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
        onOpenBrowser: () => {
          opened += 1;
        },
      }),
    );
    expect(drawn(tree)).toContain("◉ On · ▲ AUTO · masked");
    press(byId(tree, "session-info-session-Browser"));
    expect(opened).toBe(1);
  });
});

describe("SessionScreen joins them (source)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/screens/SessionScreen.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("the strip sits right above the composer, from the controller's value", () => {
    const at = source.indexOf("<RiskStrip");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(source.indexOf("<Composer\n"));
    expect(source).toContain("state.riskStrip === null");
    expect(source).toMatch(/<RiskStrip[^>]*onChange=\{openBrowser\}/);
  });

  test("Change › opens Session info ON the Browser page; a fresh open starts on the sheet", () => {
    expect(source).toMatch(
      /const openBrowser = \(\) => \{\s*openInfo\(\);\s*setInfoPage\("browser"\);\s*\};/,
    );
    expect(source).toMatch(/const openInfo = [^{]*\{\s*setInfoPage\("info"\);/);
    expect(source).toContain('infoPage === "browser" ?');
    expect(source).toContain('onBack={() => setInfoPage("info")}');
    expect(source).toContain('onOpenBrowser={() => setInfoPage("browser")}');
    expect(source).toContain('onLockedTap={() => playHaptic("light")}');
  });
});
