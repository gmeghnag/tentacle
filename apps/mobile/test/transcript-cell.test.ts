/**
 * When a memoized transcript cell may skip a redraw
 * (docs/fix/mobile-fan-jank-device.md): same data → skip, any drawn change →
 * redraw; the per-pass rebuilt cell/look objects compare by content.
 */
import { describe, expect, test } from "bun:test";
import {
  type CellData,
  sameCellData,
  sameCellProps,
  sameLook,
  sameStepCell,
} from "../src/transcript-cell.ts";

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
    compactShell: false,
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

describe("sameCellProps (the component's memo comparator)", () => {
  const actions = { current: {} };
  const props = (over: Partial<CellData> = {}, handle: unknown = actions) => ({
    ...data(over),
    actions: handle,
  });

  test("a stable handle and the same data skips the redraw", () => {
    expect(sameCellProps(props(), props())).toBe(true);
  });

  test("a streamed delta redraws the cell even though the handle is unchanged", () => {
    // The handle is ONE ref for the screen's life: if it were allowed to decide
    // alone, this row would freeze on its first delta (Review round 1, MEDIUM 1).
    expect(sameCellProps(props(), props({ row: { ...row, text: "hi there" } }))).toBe(false);
  });

  test("a fresh handle redraws even when the data is identical", () => {
    expect(sameCellProps(props(), props({}, { current: {} }))).toBe(false);
  });
});

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
      { compactShell: true },
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

  test("a context cell compares its thread", () => {
    const a = { kind: "context", thread: { up: true, down: true } } as const;
    expect(sameStepCell(a, { kind: "context", thread: { up: true, down: true } })).toBe(true);
    expect(sameStepCell(a, { kind: "context", thread: { up: true, down: false } })).toBe(false);
    expect(sameStepCell(a, { kind: "thought", ms: undefined, thread: a.thread })).toBe(false);
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
