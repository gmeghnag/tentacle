/**
 * A section's notes are BLOCKS, not one running line — the S4 review's finding 1
 * (docs/feat/mobile-chrome.md).
 *
 * Every other band test in this folder reads the SOURCE (`band-wiring.test.ts`,
 * `band-screens.test.ts`), which is why the regression S4 shipped went unseen:
 * `Section` handed `BandSection` a Fragment of `<Text>`s, `BandSection` dropped
 * that Fragment into its own footnote `<Text>`, and React Native lays a nested
 * `<Text>` out INLINE — "1 of 2 connected" ran straight into the switch note, and
 * the nested node is a virtual text node, so `session-info-switch-note-*` matched
 * no view at all (a flow tapping it would find nothing).
 *
 * So this file renders the REAL element tree of `SessionInfoSheet` (no renderer:
 * the `.tsx` components are called and the returned elements walked, which needs
 * only React itself) and asserts the property a layout would show:
 *  - one block per note, one note per block (never two notes in one run);
 *  - no `<Text>` inside a `<Text>` anywhere in the sheet — the inline layout that
 *    joins two paragraphs is exactly that shape;
 *  - the switch note's testID rides on a REAL view (a host `<Text>`), not on a
 *    nested text run.
 *
 * `react-native`/`expo-symbols`/`react-native-safe-area-context` are mocked to
 * host stubs: Bun cannot load React Native's Flow sources, and nothing here is
 * about how a view paints. The mock is process-wide (Bun's `mock.module` has no
 * per-file scope), so it is restored in `afterAll`; no other test file in this
 * package imports those three specifiers, which is what keeps that safe.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Fragment, type ReactElement, createElement as h, isValidElement } from "react";
import { type BandNote, sectionNotes } from "../src/band-notes.ts";
import type { InfoFacts, InfoSection } from "../src/session-info.ts";

/** One node of the walked element tree: a host stub, or something unexpected. */
interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

describe("`sectionNotes`: one note per block, keyed by ROLE", () => {
  const section = (over: Partial<InfoSection> = {}): InfoSection =>
    ({ id: "mcp", title: "MCP", phase: "ready", rows: [], ...over }) as InfoSection;

  test("reading order: the cap, then the count, then what the switches do", () => {
    const notes = sectionNotes(
      section({ rowsNote: "and 3 more", footer: "1 of 2 connected", switchNote: "Off hides it." }),
    );
    expect(notes.map((note) => note.key)).toEqual(["rowsNote", "footer", "switchNote"]);
    expect(notes.map((note) => note.text)).toEqual([
      "and 3 more",
      "1 of 2 connected",
      "Off hides it.",
    ]);
  });

  test("only the switch note carries a testID, and it names its section", () => {
    const notes = sectionNotes(
      section({ footer: "1 of 2 connected", switchNote: "Off hides it." }),
    );
    expect(notes.map((note) => note.testID)).toEqual([undefined, "session-info-switch-note-mcp"]);
  });

  test("an absent or blank note is not a block", () => {
    expect(sectionNotes(section())).toEqual([]);
    expect(sectionNotes(section({ footer: "", switchNote: "   " }))).toEqual([]);
  });

  test("two notes saying the SAME words still get distinct keys", () => {
    // The old shape keyed each block by its text, so a section whose count and
    // switch note coincided produced a duplicate React key (the S4 review's nit).
    const notes = sectionNotes(section({ footer: "Same words", switchNote: "Same words" }));
    expect(notes.map((note) => note.key)).toBeArray();
    expect(new Set(notes.map((note) => note.key)).size).toBe(2);
  });
});

describe("`SessionInfoSheet` renders one block per note (S4 review finding 1)", () => {
  let sheet: typeof import("../src/screens/SessionInfoSheet.tsx");
  let info: typeof import("../src/session-info.ts");
  let theme: typeof import("../src/theme.ts");

  beforeAll(async () => {
    // Host stubs are STRING element types (not functions): the walker keeps a
    // string-typed element as a node and recurses into its `children`, which is
    // what makes "a `<Text>` inside a `<Text>`" visible. A function stub would be
    // called and its result discarded, and every assertion below would pass on an
    // empty tree (found the hard way: the first version of this file reported
    // `blocks: 0` for both the buggy and the fixed code).
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
    const parts = [node.props.children];
    const flat = (value: unknown): string => {
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
      if (Array.isArray(value)) {
        return value.map(flat).join("");
      }
      if (isValidElement(value)) {
        const props = (value as { props: Record<string, unknown> }).props;
        return flat(props.children);
      }
      return "";
    };
    return parts.map(flat).join("");
  };

  /** Every host node with the node that holds it, so "inline inside a Text" is visible. */
  const parents = (
    nodes: Node[],
    parent: Node | null = null,
  ): { node: Node; parent: Node | null }[] =>
    nodes.flatMap((node) => [{ node, parent }, ...parents(node.children, node)]);

  const facts = (over: Partial<InfoFacts> = {}): InfoFacts =>
    ({
      phase: "open",
      link: "up",
      title: "Fix the flaky test",
      computerName: "MacBook Pro",
      daemon: { version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 },
      mcp: {
        state: "ready",
        value: {
          servers: [
            { name: "k8s", state: "connected", tools: [], moreTools: 0 },
            { name: "gh", state: "connected", tools: [], moreTools: 0 },
          ],
        },
      },
      skills: {
        state: "ready",
        value: {
          slash: [],
          skills: Array.from({ length: 5 }, (_unused, index) => ({
            name: `s${index}`,
            description: "A skill",
            scope: "user" as const,
            user: true,
            model: true,
            location: `/s/${index}/SKILL.md`,
          })),
          problems: [],
          moreProblems: 0,
        },
      },
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
      capabilities: {
        phase: "on",
        state: { disabledMcp: [], disabledSkills: [] },
        changedBy: {},
        error: null,
      },
      ...over,
    }) as InfoFacts;

  /** The sheet's host tree for one set of facts. */
  const renderSheet = (over: Partial<InfoFacts> = {}): Node[] =>
    walk(
      h(sheet.SessionInfoSheet, {
        palette: theme.darkPalette,
        view: info.sessionInfoView(facts(over)),
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

  /** The notes the view-model gives every section, flattened. */
  const allNotes = (over: Partial<InfoFacts> = {}): { section: InfoSection; note: BandNote }[] =>
    info
      .sessionInfoView(facts(over))
      .sections.flatMap((section) => sectionNotes(section).map((note) => ({ section, note })));

  /** The three-notes-in-one-section case: no servers, so Skills explains the switches. */
  const noServers = (): Partial<InfoFacts> => ({
    mcp: { state: "ready", value: { servers: [] } },
    skills: {
      state: "ready",
      value: {
        slash: [],
        skills: Array.from({ length: info.MAX_SKILL_ROWS + 5 }, (_unused, index) => ({
          name: `s${index}`,
          description: "A skill",
          scope: "user" as const,
          user: true,
          model: true,
          location: `/s/${index}/SKILL.md`,
        })),
        problems: ["one skipped"],
        moreProblems: 0,
      },
    },
  });

  /** Both fixtures: MCP's count + switch note, and Skills' three notes. */
  const fixtures = (): readonly {
    name: string;
    over: Partial<InfoFacts>;
    counts: Record<string, number>;
  }[] => [
    { name: "servers", over: {}, counts: { mcp: 2 } },
    { name: "no servers", over: noServers(), counts: { skills: 3 } },
  ];

  test("each fixture really does produce multi-note sections (non-vacuity)", () => {
    // Without this, "one block per note" would hold trivially on a sheet with one
    // note per section: MCP has a count AND a switch note, and with no servers
    // Skills carries all three (the review's own example). A section with no note
    // is absent from the map (it has nothing to lay out).
    expect(
      fixtures().map(({ name, over }) => {
        const perSection = new Map<string, number>();
        for (const { section } of allNotes(over)) {
          perSection.set(section.id, (perSection.get(section.id) ?? 0) + 1);
        }
        return { name, counts: Object.fromEntries(perSection) };
      }),
    ).toEqual(fixtures().map(({ name, counts }) => ({ name, counts })));
  });

  test("each note is its own block: never two notes inside one text run", () => {
    for (const { name, over } of fixtures()) {
      const tree = renderSheet(over);
      const texts = parents(tree).filter(({ node }) => node.type === "Text");
      // The walk must actually see the sheet, or every assertion below is vacuous.
      expect({ name, textBlocks: texts.length > 10 }).toEqual({ name, textBlocks: true });
      for (const { section, note } of allNotes(over)) {
        const block = texts.filter(({ node }) => textOf(node) === note.text);
        // Exactly one block says it (two would be a duplicated note) …
        expect({ name, note: note.key, section: section.id, blocks: block.length }).toEqual({
          name,
          note: note.key,
          section: section.id,
          blocks: 1,
        });
        // … and that block is a paragraph of its own, not inline inside another.
        expect({ name, note: note.key, parent: block[0]?.parent?.type }).toEqual({
          name,
          note: note.key,
          parent: "View",
        });
      }
    }
  });

  test("no `<Text>` is nested in a `<Text>` anywhere in the sheet", () => {
    // The shape that joins two paragraphs into one line. RN lays it out inline,
    // so the only safe count is zero.
    for (const { name, over } of fixtures()) {
      const nested = parents(renderSheet(over)).filter(
        ({ node }) => node.type === "Text" && node.children.some((child) => child.type === "Text"),
      );
      expect({ name, nested: nested.map(({ node }) => textOf(node)) }).toEqual({
        name,
        nested: [],
      });
    }
  });

  test("the switch note's testID is on a real view, per section", () => {
    // A nested `<Text>` is a virtual text node on iOS: the id matches no view, so
    // a flow (or a UI test) tapping `session-info-switch-note-*` finds nothing.
    for (const { name, over } of fixtures()) {
      const tree = parents(renderSheet(over));
      for (const section of info.sessionInfoView(facts(over)).sections) {
        const id = `session-info-switch-note-${section.id}`;
        const hosts = tree.filter(({ node }) => node.props.testID === id);
        const expected = sectionNotes(section).some((note) => note.testID === id) ? 1 : 0;
        expect({ name, id, hosts: hosts.length }).toEqual({ name, id, hosts: expected });
        for (const { node, parent } of hosts) {
          expect({ name, id, type: node.type, parent: parent?.type }).toEqual({
            name,
            id,
            type: "Text",
            parent: "View",
          });
        }
      }
    }
  });
});
