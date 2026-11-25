/**
 * docs/feat/mobile-shell-output-scroll.md Design 3 — `stickyState`: which open
 * output's step row sticks to the top of the screen, and how far the block's end
 * (or the next block's handover) has pushed it up.
 */
import { describe, expect, test } from "bun:test";
import { type StickyBlock, openOutputSteps, stickyState } from "../src/output-sticky.ts";
import type { Row } from "../src/transcript-rows.ts";

const block = (key: string, top: number, bottom: number): StickyBlock => ({
  key,
  top,
  bottom,
  headH: 40,
  bodyTop: top + 40,
  lineH: 17,
  lines: Math.floor((bottom - top - 40) / 17),
  lineOffset: 0,
});

describe("stickyState", () => {
  const a = block("a", 100, 800);

  test("sticks while the top of the screen is inside the block", () => {
    const s = stickyState(300, [a]);
    expect(s).toMatchObject({ key: "a", offsetY: 0 });
  });

  test("not before the block starts (it returns in place) nor at/after its end", () => {
    expect(stickyState(99, [a])).toBeNull();
    expect(stickyState(100, [a])?.key).toBe("a");
    expect(stickyState(800, [a])).toBeNull();
    expect(stickyState(900, [a])).toBeNull();
  });

  test("the block's end pushes it up: offsetY = bottom - headH - scrollY, only below 0", () => {
    expect(stickyState(760, [a])?.offsetY).toBe(0);
    expect(stickyState(780, [a])?.offsetY).toBe(-20);
    expect(stickyState(799, [a])?.offsetY).toBe(-39);
  });

  test("handover: the next open block's head pushes the previous one away", () => {
    const b = block("b", 800, 1500);
    const blocks = [a, b];
    expect(stickyState(780, blocks)).toMatchObject({ key: "a", offsetY: -20 });
    // Exactly at the boundary the next one takes over, in place.
    expect(stickyState(800, blocks)).toMatchObject({ key: "b", offsetY: 0 });
    expect(stickyState(1000, blocks)).toMatchObject({ key: "b", offsetY: 0 });
  });

  test("a block no taller than its head never sticks; none / empty → null", () => {
    expect(stickyState(120, [block("s", 100, 130)])).toBeNull();
    expect(stickyState(300, [])).toBeNull();
  });

  test("the position «line X of N»: the first line under the sticky row, clamped", () => {
    const s = stickyState(a.bodyTop + 17 * 9 - a.headH, [a]);
    expect(s?.total).toBe(a.lines);
    expect(s?.line).toBe(10);
    expect(stickyState(100, [a])?.line).toBe(1);
    const late = stickyState(799, [a]);
    expect(late?.line).toBeLessThanOrEqual(a.lines);
  });

  test("a collapsed step is simply not in `blocks`: nothing sticks", () => {
    expect(stickyState(300, [])).toBeNull();
  });
});

describe("openOutputSteps: which rows can stick", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
  const row = (key: string, output: string | undefined): Row => ({
    kind: "tool",
    key,
    id: key,
    name: "shell",
    label: "Bash",
    args: JSON.stringify({ command: "bun test" }),
    status: "ok",
    ...(output === undefined ? {} : { output }),
  });

  test("only OPEN steps with an output; total counts the cut head too", () => {
    const rows = [
      row("a", lines(400)),
      row("b", lines(3)),
      row("c", undefined),
      row("d", lines(50)),
    ];
    const got = openOutputSteps(rows, ["a", "c"], [], new Map(), false);
    expect([...got.keys()]).toEqual(["a"]);
    expect(got.get("a")).toMatchObject({ total: 400, label: "bun test" });
  });

  test("collapsed step: not a candidate; full shows the same total", () => {
    const rows = [row("a", lines(400))];
    expect(openOutputSteps(rows, [], [], new Map(), false).size).toBe(0);
    expect(openOutputSteps(rows, ["a"], ["a"], new Map(), false).get("a")?.total).toBe(400);
  });
});

describe("cut output: «line X of N» counts the hidden head", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
  test("openOutputSteps → stickyState with full=[] reports the real line", () => {
    const rows: Row[] = [
      {
        kind: "tool",
        key: "a",
        id: "a",
        name: "shell",
        label: "Bash",
        args: JSON.stringify({ command: "bun test" }),
        status: "ok",
        output: lines(400),
      },
    ];
    const step = openOutputSteps(rows, ["a"], [], new Map(), false).get("a");
    expect(step?.skipped).toBeGreaterThan(0);
    const b: StickyBlock = {
      key: "a",
      top: 0,
      bottom: 400,
      headH: 40,
      bodyTop: 40,
      lineH: 17,
      lines: step?.total ?? 0,
      lineOffset: step?.skipped ?? 0,
    };
    // Screen top at the body start: the first DRAWN line is line skipped+1.
    expect(stickyState(0, [b])?.line).toBe((step?.skipped ?? 0) + 1);
    expect(stickyState(0, [b])?.total).toBe(400);
  });

  test("a short open output (2 lines) never sticks", () => {
    const short: StickyBlock = { ...block("s", 0, 40 + 2 * 17 + 8), lines: 2 };
    expect(stickyState(10, [short])).toBeNull();
  });
});
