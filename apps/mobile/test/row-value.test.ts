/**
 * The E2 row's value geometry (docs/feat/mobile-chrome.md Design 4, S3): which
 * end of a value its ellipsis eats, and when the value drops below the label.
 *
 * Both are decisions, not looks, so they live in a pure module `ui/Row.tsx` can
 * import — the component itself is unimportable from Bun (React Native's sources
 * are Flow), which is exactly why §7 puts the branching here (F10).
 */
import { describe, expect, test } from "bun:test";
import { ROW_WRAP_AT, type RowValueKind, rowLayout, valueEllipsis } from "../src/row-value.ts";

const KINDS: readonly RowValueKind[] = ["text", "path", "model"];
const RN_MODES = ["head", "middle", "tail"] as const;

describe("S3 · `valueEllipsis` — the ellipsis follows the KIND, not the width", () => {
  test("a path eats its head: the tail is what tells two paths apart", () => {
    // mockup `infoE2`: `~/src/hop-live/proj` with `direction: rtl` — the visible
    // part is the END of the path.
    expect(valueEllipsis("path")).toBe("head");
  });

  test("a model id eats its middle: the family prefix and the quant suffix both matter", () => {
    expect(valueEllipsis("model")).toBe("middle");
  });

  test("prose eats its tail", () => {
    expect(valueEllipsis("text")).toBe("tail");
  });

  test("every kind answers a mode React Native accepts (no `undefined` in a row)", () => {
    for (const kind of KINDS) {
      expect(RN_MODES).toContain(valueEllipsis(kind));
    }
    // Non-vacuity: the mapping really is per-kind, not one constant.
    expect(new Set(KINDS.map(valueEllipsis)).size).toBe(3);
  });
});

describe("S3 · `rowLayout` — a value drops below the label at the largest type (F10)", () => {
  test("at the default type the label and its value share one line", () => {
    expect(rowLayout(1)).toEqual({
      direction: "row",
      valueAlign: "right",
      valueFullWidth: false,
      controlAlign: "center",
    });
  });

  test("just under the threshold still shares the line", () => {
    expect(rowLayout(1.39).direction).toBe("row");
  });

  test("at the threshold the value drops under the label, full width, still right-aligned", () => {
    expect(ROW_WRAP_AT).toBe(1.4);
    expect(rowLayout(ROW_WRAP_AT)).toEqual({
      direction: "column",
      valueAlign: "right",
      valueFullWidth: true,
      controlAlign: "top",
    });
    expect(rowLayout(2).direction).toBe("column");
  });

  test("a broken reading falls back to the safe, one-line layout", () => {
    // `fontScale` comes from the platform; `NaN`/`Infinity` must never produce a
    // row whose label has zero width.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(rowLayout(bad)).toEqual({
        direction: "row",
        valueAlign: "right",
        valueFullWidth: false,
        controlAlign: "center",
      });
    }
  });

  test("a description under the label top-aligns the trailing control at any size", () => {
    // Design 4: "a row with a description puts it under the label, the switch
    // top-aligned" — a 31 pt switch floating in the middle of a two-line label
    // is the bug, and it is not a large-type-only problem.
    expect(rowLayout(1, { description: true }).controlAlign).toBe("top");
    expect(rowLayout(1, { description: true }).direction).toBe("row");
    expect(rowLayout(1, { description: false }).controlAlign).toBe("center");
    expect(rowLayout(ROW_WRAP_AT, { description: true })).toEqual({
      direction: "column",
      valueAlign: "right",
      valueFullWidth: true,
      controlAlign: "top",
    });
  });

  test("the value is right-aligned in BOTH modes (it never flips side)", () => {
    for (const scale of [1, 1.4, 3]) {
      expect(rowLayout(scale).valueAlign).toBe("right");
    }
  });
});
