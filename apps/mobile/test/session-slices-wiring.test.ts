/**
 * docs/feat/mobile-ui-fluidity-s3.md: the wiring the slices stand on, pinned from
 * the source (the components are `.tsx`, unimportable from Bun — the
 * `fan-jank-wiring.test.ts` pattern). What a slice carries is
 * `session-store.test.ts`'s; whether a pane's props stay put is measured in the
 * app (`ev=panes`, the perf budget's `coupling`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
/** The source with its comment lines removed: prose may name what the code must not do. */
const code = (...p: string[]) =>
  readFileSync(join(SRC, ...p), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\{\/\*|\/\/)/.test(line))
    .join("\n");

const SCREEN = code("screens", "SessionScreen.tsx");
const PANES = [
  { component: "HeaderPane", slice: "header" },
  { component: "ComposerPane", slice: "composer" },
  { component: "HubPane", slice: "hub" },
  { component: "SheetsPane", slice: "sheets" },
] as const;
const paneSource = (component: string) => code("screens", "session", `${component}.tsx`);

describe("the screen follows slices, never the whole state", () => {
  test("no pane and no `ui/` component names `SessionScreenState`", () => {
    for (const dir of [["screens", "session"], ["ui"]]) {
      for (const file of readdirSync(join(SRC, ...dir), { recursive: true }) as string[]) {
        if (/\.tsx?$/.test(file)) {
          expect([file, code(...dir, file).includes("SessionScreenState")]).toEqual([file, false]);
        }
      }
    }
  });

  test("the shell holds no copy of the state and has no whole-state subscription", () => {
    expect(SCREEN).not.toContain("useState<SessionScreenState>");
    expect(SCREEN).not.toContain("controller.subscribe(");
    expect(SCREEN).toContain('useSlice(store, "rows")');
  });
});

describe("the four panes", () => {
  for (const { component, slice } of PANES) {
    test(`${component} is memoized, follows \`${slice}\`, never \`rows\`, and is counted`, () => {
      const pane = paneSource(component);
      expect(pane).toContain(`export const ${component} = memo(function ${component}(`);
      expect(pane).toContain(`useSlice(store, "${slice}")`);
      expect(pane.match(/useSlice\(/g)).toHaveLength(1);
      expect(pane).not.toContain('"rows"');
      expect(pane).toContain(`PERF.pane("${slice}");`);
    });

    test(`<${component}> takes no inline closure prop`, () => {
      const at = SCREEN.indexOf(`<${component}\n`);
      expect(at).toBeGreaterThan(-1);
      const end = SCREEN.indexOf("/>", at);
      const element = SCREEN.slice(at, end + 2);
      // Non-vacuity: the slice really is the whole element.
      expect(element).toContain("actions={paneActions}");
      expect(element).not.toContain("=>");
      expect(element).not.toMatch(/=\{\s*(\{|\[)/);
    });
  }

  // The heuristic for "`store.get` only inside a handler, never in render": a pane
  // does not call it at all, and in the shell no statement at the component's own
  // depth (two spaces, `/^ {2}\S.*store\.get\(/`) does.
  test("`store.get` is never read during a render (no tearing)", () => {
    for (const { component } of PANES) {
      expect(paneSource(component)).not.toContain("store.get(");
    }
    expect(SCREEN).toContain("store.get(");
    expect(SCREEN).not.toMatch(/^ {2}\S.*store\.get\(/m);
  });
});

describe("the native sheets are republished only when their inputs change", () => {
  test("the publish is `SheetsPane`'s effect, with a dependency list", () => {
    expect(SCREEN).not.toContain("host.publish(");
    expect(paneSource("SheetsPane")).toMatch(
      /useLayoutEffect\(\(\) => \{\n[\s\S]*?host\.publish\([\s\S]*?\n {2}\}, \[\n\s*owner,\n\s*palette,\n\s*slice,/,
    );
  });
});

describe("the shell's pane props keep their identity over a delta", () => {
  test("the computed ones are memoized, and the closed menus are constants", () => {
    for (const name of [
      "reports",
      "activityInput",
      "detailInput",
      "activityVm",
      "activityDetail",
      "hubCtx",
      "hub",
      "menu",
    ]) {
      const memo = new RegExp(`const ${name} = useMemo(<\\w+>)?\\(`);
      expect([name, memo.test(SCREEN)]).toEqual([name, true]);
    }
    expect(SCREEN).toContain('hubMenu === "all" ? hub.all : NO_HUB_ITEMS;');
    expect(SCREEN).toContain(": NO_MENU)");
  });
});
