/**
 * When a memoized transcript cell may skip a redraw
 * (docs/fix/mobile-fan-jank-device.md): same data → skip, any drawn change →
 * redraw; the per-pass rebuilt cell/look objects compare by content.
 */
import { describe, expect, test } from "bun:test";
import { type CellData, sameCellData, sameLook, sameStepCell } from "../src/transcript-cell.ts";

const row = { kind: "assistant", key: "a1", text: "hi" };
const palette = { page: "#fff" };
const thumbs = { byId: new Map() };

function data(over: Partial<CellData> = {}): CellData {
  return {
    row,
    cell: { kind: "step", thought: null, thoughtFirst: false, thread: { up: false, down: true } },
    look: { glyph: null, joined: false },
    open: false,
    full: false,
    reduceMotion: false,
    speak: undefined,
    child: null,
    voice: false,
    artifacts: true,
    palette,
    thumbnails: thumbs,
    diagramStyle: "native",
    chartLabels: "inside",
    ...over,
  };
}

describe("sameCellData", () => {
  test("a fresh layout pass (new cell/look objects, same content) skips", () => {
    expect(sameCellData(data(), data())).toBe(true);
  });

  test("every drawn field forces a redraw", () => {
    const changes: Partial<CellData>[] = [
      { row: { ...row, text: "hi there" } },
      {
        cell: {
          kind: "step",
          thought: "x",
          thoughtFirst: false,
          thread: { up: false, down: true },
        },
      },
      {
        cell: {
          kind: "step",
          thought: null,
          thoughtFirst: true,
          thread: { up: false, down: true },
        },
      },
      {
        cell: {
          kind: "step",
          thought: null,
          thoughtFirst: false,
          thread: { up: true, down: true },
        },
      },
      {
        cell: {
          kind: "step",
          thought: null,
          thoughtFirst: false,
          thread: { up: false, down: false },
        },
      },
      { cell: { kind: "thought", ms: 10, thread: { up: false, down: true } } },
      { cell: undefined },
      { look: { glyph: null, joined: true } },
      { look: undefined },
      { open: true },
      { full: true },
      { reduceMotion: true },
      { speak: "offered" },
      { child: "sub-1" },
      { voice: true },
      { artifacts: false },
      { palette: { page: "#000" } },
      { thumbnails: { byId: new Map() } },
      { diagramStyle: "sketch" },
      { chartLabels: "legend" },
    ];
    for (const change of changes) {
      expect({ change, same: sameCellData(data(), data(change)) }).toEqual({
        change,
        same: false,
      });
    }
  });

  test("a thought cell compares its duration and thread", () => {
    const a = { kind: "thought", ms: 10, thread: { up: true, down: false } } as const;
    expect(sameStepCell(a, { ...a, thread: { up: true, down: false } })).toBe(true);
    expect(sameStepCell(a, { ...a, ms: undefined })).toBe(false);
    expect(sameStepCell({ kind: "hidden" }, { kind: "hidden" })).toBe(true);
    expect(sameStepCell(undefined, undefined)).toBe(true);
    expect(sameLook(undefined, { glyph: null, joined: false })).toBe(false);
  });
});
