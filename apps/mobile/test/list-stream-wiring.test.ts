/**
 * docs/feat/mobile-ui-fluidity-s4.md: the transcript list is off the stream
 * path, pinned from the source (the components are `.tsx`, unimportable from
 * Bun). What the slices carry is `session-store.test.ts`'s; the renders are
 * measured in the app (`ev=panes`, the perf budget's `coupling`).
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

/** The `<FlatList … />` element of the transcript. */
function list(): string {
  const at = SCREEN.indexOf("<FlatList\n");
  const end = SCREEN.indexOf("<StickyHost", at);
  expect(at).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  return SCREEN.slice(at, end);
}

describe("the FlatList's props keep their identity over a delta", () => {
  test("memoized renderer, one cell environment, a memoized footer", () => {
    const element = list();
    // Without `strictMode` every FlatList render builds a new item renderer and
    // re-runs it for every mounted cell (FlatList.js `_memoizedRenderer`).
    expect(element).toMatch(/^\s+strictMode$/m);
    expect(element).toContain("data={data}");
    expect(element).toContain("renderItem={renderCell}");
    expect(element).toContain("extraData={cellEnv}");
    expect(element).toContain("ListFooterComponent={tailFooter}");
  });

  test("`data`, `cellEnv`, `renderCell` and `tailFooter` are memoized", () => {
    for (const name of ["data", "cells", "looks", "cellEnv", "tailFooter"]) {
      expect([name, new RegExp(`const ${name} = useMemo\\b`).test(SCREEN)]).toEqual([name, true]);
    }
    expect(SCREEN).toMatch(/const renderCell = useCallback\([\s\S]*?\[cellEnv, store\],?\s*\);/);
  });
});

describe("the live row and the Thinking tail are read from `tail`, never by the shell", () => {
  test("the shell derives nothing from the full rows", () => {
    expect(SCREEN).not.toContain("stepLayout(");
    expect(SCREEN).not.toContain("noticeLooks(");
    expect(SCREEN).not.toContain('useSlice(store, "tail")');
    expect(SCREEN).not.toContain("rowsSlice.view.rows");
  });

  test("only `TailPane` and `TranscriptCell.tsx` follow `tail`", () => {
    const followers = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => code(file).includes('useSlice(store, "tail")'))
      .sort();
    expect(followers).toEqual([
      "screens/session/TailPane.tsx",
      "screens/transcript/TranscriptCell.tsx",
    ]);
  });

  test("`TailPane` is memoized and counted; each `renderItem` call is counted", () => {
    const pane = code("screens", "session", "TailPane.tsx");
    expect(pane).toContain("export const TailPane = memo(function TailPane(");
    expect(pane).toContain('PERF.pane("tail");');
    expect(SCREEN).toMatch(/const renderCell = useCallback\([\s\S]{0,200}?PERF\.pane\("cells"\);/);
  });

  test("`<TailPane>` takes no inline closure prop", () => {
    const at = SCREEN.indexOf("<TailPane");
    expect(at).toBeGreaterThan(-1);
    const element = SCREEN.slice(at, SCREEN.indexOf("/>", at) + 2);
    expect(element).toContain("store={store}");
    expect(element).not.toContain("=>");
    expect(element).not.toMatch(/=\{\s*(\{|\[)/);
  });

  test("the live cell draws only an assistant row of its own key", () => {
    const cell = code("screens", "transcript", "TranscriptCell.tsx");
    expect(cell).toContain("export const LiveCell = memo(function LiveCell(");
    expect(cell).toContain('live.kind !== "assistant"');
    expect(cell).toContain("live.key !== rowKey");
    expect(cell).toContain("cellDataOf(live, env, true)");
  });
});
