import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type { ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import { type MouseSnapshot, type MouseState, dispatchMouse } from "../src/mouse-stream.ts";
import { COPY_MIN_CELLS, copiedLabel, isDeliberate } from "../src/selection.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;
const drag = (x: number, y: number): string => `\u001B[<32;${x};${y}M`;
const release = (x: number, y: number): string => `\u001B[<0;${x};${y}m`;

const noopEnv: ExecutionEnvironment = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
  cwd: () => "/tmp/work",
} as unknown as ExecutionEnvironment;

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private i = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const e of this.turns[this.i++] ?? [{ type: "done" } as StreamEvent]) {
      yield e;
    }
  }
}

const mount = (copied: string[], model = new Scripted([])) =>
  render(
    <App
      agent={new Agent({ model, tools: new ToolRegistry(), env: noopEnv })}
      model="qwen3"
      cwd="/tmp/work"
      clipboard={async (t) => {
        copied.push(t);
      }}
    />,
  );

describe("isDeliberate (pure rule)", () => {
  const at = (row: number, col: number) => ({ row, col });
  test("single row: needs COPY_MIN_CELLS cells", () => {
    expect(COPY_MIN_CELLS).toBe(3);
    expect(isDeliberate({ anchor: at(0, 4), head: at(0, 4) })).toBe(false);
    expect(isDeliberate({ anchor: at(0, 4), head: at(0, 6) })).toBe(false);
    expect(isDeliberate({ anchor: at(0, 6), head: at(0, 4) })).toBe(false);
    expect(isDeliberate({ anchor: at(0, 4), head: at(0, 7) })).toBe(true);
    expect(isDeliberate({ anchor: at(0, 7), head: at(0, 4) })).toBe(true);
  });
  // A cell is ~2x taller than wide: a press a pixel from a row boundary emits
  // ONE drag report on the next row. A row change alone must not copy the rest
  // of that row plus the next one's prefix.
  test("a one-row jump needs COPY_MIN_CELLS of physical travel, on either axis", () => {
    // The jitter: one row, a cell or two along it.
    expect(isDeliberate({ anchor: at(0, 4), head: at(1, 6) })).toBe(false);
    expect(isDeliberate({ anchor: at(1, 6), head: at(0, 4) })).toBe(false);
    expect(isDeliberate({ anchor: at(0, 4), head: at(1, 3) })).toBe(false);
    // The ordinary gesture for a phrase that wraps: the tail of one row, the
    // head of the next. The head is LEFT of the anchor — real travel, a copy.
    expect(isDeliberate({ anchor: at(0, 40), head: at(1, 5) })).toBe(true);
    expect(isDeliberate({ anchor: at(1, 5), head: at(0, 40) })).toBe(true);
    // One row crossed with a real travel along it.
    expect(isDeliberate({ anchor: at(0, 4), head: at(1, 7) })).toBe(true);
    expect(isDeliberate({ anchor: at(1, 4), head: at(0, 1) })).toBe(true);
    // Two rows apart is deliberate on its own.
    expect(isDeliberate({ anchor: at(0, 4), head: at(2, 4) })).toBe(true);
    expect(isDeliberate({ anchor: at(2, 4), head: at(0, 4) })).toBe(true);
  });
  test("copiedLabel", () => {
    expect(copiedLabel(8)).toBe("Copied · 8 chars");
    expect(copiedLabel(1)).toBe("Copied · 1 char");
  });
});

describe("accidental copy", () => {
  test("a 2-cell drag on the header is a click, not a copy", async () => {
    const copied: string[] = [];
    const { stdin, unmount } = mount(copied);
    await delay(40);
    stdin.write(press(3, 1));
    await delay(15);
    stdin.write(drag(5, 1));
    await delay(15);
    stdin.write(release(5, 1));
    await delay(60);
    expect(copied).toEqual([]);
    unmount();
  });

  test("a one-row vertical jitter is a click, not a copy", async () => {
    const copied: string[] = [];
    const { stdin, unmount } = mount(copied);
    await delay(40);
    stdin.write(press(3, 1));
    await delay(15);
    stdin.write(drag(4, 2));
    await delay(15);
    stdin.write(release(4, 2));
    await delay(60);
    expect(copied).toEqual([]);
    unmount();
  });

  test("crossing one row with a real horizontal travel still copies", async () => {
    const copied: string[] = [];
    const { stdin, unmount } = mount(copied);
    await delay(40);
    stdin.write(press(1, 1));
    await delay(15);
    stdin.write(drag(4, 2));
    await delay(15);
    stdin.write(release(4, 2));
    await delay(60);
    expect(copied).toHaveLength(1);
    expect(copied[0]?.startsWith("ten")).toBe(true);
    unmount();
  });

  // The gesture for a phrase that wraps: press near the end of one row, drag to
  // the start of the next. The head sits LEFT of the anchor; requiring forward
  // travel here silently dropped the copy (and the clipboard kept old text).
  test("a wrapped phrase: tail of one row to the head of the next still copies", async () => {
    const copied: string[] = [];
    const { stdin, lastFrame, unmount } = mount(copied);
    await delay(40);
    stdin.write(press(10, 1));
    await delay(15);
    stdin.write(drag(2, 2));
    await delay(15);
    stdin.write(release(2, 2));
    await delay(60);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("\n");
    expect(lastFrame() ?? "").toContain("Copied · ");
    unmount();
  });

  test("a 3-cell drag still copies the exact text and the status bar says so", async () => {
    const copied: string[] = [];
    const { stdin, lastFrame, unmount } = mount(copied);
    await delay(40);
    stdin.write(press(1, 1));
    await delay(15);
    stdin.write(drag(4, 1));
    await delay(15);
    stdin.write(release(4, 1));
    await delay(60);
    expect(copied).toEqual(["ten"]);
    expect(lastFrame() ?? "").toContain("Copied · 3 chars");
    unmount();
  });

  test("a multi-row selection copies, the feedback shows, the scroll offset is unchanged", async () => {
    const copied: string[] = [];
    const turns = Array.from({ length: 12 }, (_, i) => [
      { type: "text", delta: `reply-${i}-a\nreply-${i}-b` } as StreamEvent,
      { type: "done" } as StreamEvent,
    ]);
    const { stdin, lastFrame, unmount } = mount(copied, new Scripted(turns));
    await delay(40);
    for (let i = 0; i < 12; i++) {
      stdin.write(`m${i}`);
      await delay(20);
      stdin.write("\r");
      await delay(120);
    }
    // Scroll up (wheel) so the viewport is NOT at the tail.
    for (let i = 0; i < 4; i++) {
      stdin.write("\u001B[<64;10;5M");
      await delay(20);
    }
    const before = lastFrame() ?? "";
    expect(before).toContain("more (↓ to follow)");
    const body = (f: string): string => f.split("\n").slice(0, -1).join("\n");
    stdin.write(press(1, 2));
    await delay(15);
    stdin.write(drag(6, 4));
    await delay(15);
    stdin.write(release(6, 4));
    await delay(80);
    const after = lastFrame() ?? "";
    expect(copied).toHaveLength(1);
    expect(copied[0]?.includes("\n")).toBe(true);
    expect(after).toContain("Copied · ");
    expect(after).toContain(`${copied[0]?.length} chars`);
    // Still scrolled up, same hidden-above count, same transcript body.
    expect(after).toContain("more (↓ to follow)");
    expect(body(after)).toBe(body(before));
    unmount();
  });

  test("the feedback is transient", async () => {
    const copied: string[] = [];
    const { stdin, lastFrame, unmount } = mount(copied);
    await delay(40);
    stdin.write(press(1, 1));
    await delay(15);
    stdin.write(drag(5, 1));
    await delay(15);
    stdin.write(release(5, 1));
    await delay(60);
    expect(lastFrame() ?? "").toContain("Copied · 4 chars");
    await delay(2300);
    expect(lastFrame() ?? "").not.toContain("Copied");
    unmount();
  });
});

describe("dispatchMouse release", () => {
  test("emits copySelection only for a deliberate selection", () => {
    const snap = {
      listView: null,
      panelBodyTop: 0,
      statusRow: null,
      dockTop: null,
      dockView: null,
      visibleCount: 10,
      win: { start: 0 },
      laid: [],
      expandAll: false,
      artifactOf: () => undefined,
      toolAt: () => null,
    } as unknown as MouseSnapshot;
    const rel = { x: 5, y: 1, btn: 0, press: false } as never;
    const mk = (c1: number, r1 = 0, c0 = 1): MouseState =>
      ({
        click: { armed: null },
        selection: { anchor: { row: 0, col: c0 }, head: { row: r1, col: c1 } },
      }) as unknown as MouseState;
    const kinds = (s: MouseState) => dispatchMouse(s, rel, snap).effects.map((e) => e.kind);
    expect(kinds(mk(2))).toEqual([]);
    expect(kinds(mk(4))).toEqual(["copySelection"]);
    // One row down with 2 cells of travel: the vertical jitter, never a copy.
    expect(kinds(mk(3, 1))).toEqual([]);
    expect(kinds(mk(4, 1))).toEqual(["copySelection"]);
    // One row down, the head back at the next row's start: a wrapped phrase.
    expect(kinds(mk(5, 1, 40))).toEqual(["copySelection"]);
    expect(kinds(mk(4, 2))).toEqual(["copySelection"]);
  });
});
