/**
 * The E2 row's value geometry (docs/feat/mobile-chrome.md Design 4, S3): which
 * end of a value its ellipsis eats, and when the value drops below the label.
 *
 * Both are decisions, not looks, so they live in a pure module `ui/Row.tsx` can
 * import — the component itself is unimportable from Bun (React Native's sources
 * are Flow), which is exactly why §7 puts the branching here (F10).
 */
import { describe, expect, test } from "bun:test";
import {
  ROW_WRAP_AT,
  type RowValueKind,
  rowAccessibility,
  rowLayout,
  valueEllipsis,
} from "../src/row-value.ts";

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
      valueAlign: "right",
      valueFullWidth: false,
      controlAlign: "center",
      labelSizing: "fill",
    });
  });

  test("just under the threshold still shares the line", () => {
    expect(rowLayout(1.39).valueFullWidth).toBe(false);
  });

  test("at the threshold the value drops under the label, full width, still right-aligned", () => {
    expect(ROW_WRAP_AT).toBe(1.4);
    expect(rowLayout(ROW_WRAP_AT)).toEqual({
      valueAlign: "right",
      valueFullWidth: true,
      controlAlign: "top",
      labelSizing: "stacked",
    });
    expect(rowLayout(2).valueFullWidth).toBe(true);
  });

  test("a broken reading falls back to the safe, one-line layout", () => {
    // `fontScale` comes from the platform; `NaN`/`Infinity` must never produce a
    // row whose label has zero width.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(rowLayout(bad)).toEqual({
        valueAlign: "right",
        valueFullWidth: false,
        controlAlign: "center",
        labelSizing: "fill",
      });
    }
  });

  test("a description under the label top-aligns the trailing control at any size", () => {
    // Design 4: "a row with a description puts it under the label, the switch
    // top-aligned" — a 31 pt switch floating in the middle of a two-line label
    // is the bug, and it is not a large-type-only problem.
    expect(rowLayout(1, { description: true }).controlAlign).toBe("top");
    expect(rowLayout(1, { description: true }).valueFullWidth).toBe(false);
    expect(rowLayout(1, { description: false }).controlAlign).toBe("center");
    expect(rowLayout(ROW_WRAP_AT, { description: true })).toEqual({
      valueAlign: "right",
      valueFullWidth: true,
      controlAlign: "top",
      labelSizing: "stacked",
    });
  });

  test("the value is right-aligned in BOTH modes (it never flips side)", () => {
    for (const scale of [1, 1.4, 3]) {
      expect(rowLayout(scale).valueAlign).toBe("right");
    }
  });
});

describe("S3 · the label column's SIZING (fix round 1: `flexShrink: 0` overflowed)", () => {
  // The bug: a label column that refuses to shrink (`flexShrink: 0`) takes its
  // MEASURED width, so a long title pushes the chevron/switch past the row's
  // edge — measured with Yoga (RN's engine) at 390 pt: 396, and 475 with a tile
  // (`.tentacle/tmp/mobile-chrome/f1r1-yoga5.out`). "Never truncated" (Design 4)
  // means the label WRAPS — not that it may overflow.
  test("with no value beside it the label FILLS the row and shrinks to wrap", () => {
    // Nothing else claims the width, so the label takes all of it; shrinking is
    // what turns "does not fit" into a second line instead of an overflow.
    expect(rowLayout(1).labelSizing).toBe("fill");
  });

  test("with a value beside it the label is CAPPED, so the value keeps a column", () => {
    expect(rowLayout(1, { hasValue: true }).labelSizing).toBe("capped");
  });

  test("stacked (large type, or any size with a value) the label owns the row", () => {
    // `valueFullWidth` already moves the value under the label: no cap is needed.
    expect(rowLayout(ROW_WRAP_AT, { hasValue: true }).labelSizing).toBe("stacked");
    expect(rowLayout(ROW_WRAP_AT).labelSizing).toBe("stacked");
  });

  test("a broken scale still fills (never a zero-width label)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rowLayout(bad).labelSizing).toBe("fill");
      expect(rowLayout(bad, { hasValue: true }).labelSizing).toBe("capped");
    }
  });
});

describe("rowAccessibility (fix/mobile-e2e-reds, flows 34-hub-dictate / 25-session-info)", () => {
  test("a row with its own action and no control is ONE element (one button)", () => {
    expect(rowAccessibility({ pressable: true, control: false })).toEqual({
      group: true,
      textButton: false,
    });
  });

  test("a row whose only control is a trailing switch never swallows it", () => {
    // Grouped, the row was a DISABLED element ("Dictation, Dictation") and the
    // switch inside it was unreachable to VoiceOver and to XCUITest alike.
    expect(rowAccessibility({ pressable: false, control: true })).toEqual({
      group: false,
      textButton: false,
    });
  });

  test("a row with BOTH an action and a switch keeps both reachable: the switch its own element, the label the button", () => {
    // Session info's MCP row (opens its tools AND switches the server): grouped,
    // its switch could not be reached at all (flow 25).
    expect(rowAccessibility({ pressable: true, control: true })).toEqual({
      group: false,
      textButton: true,
    });
  });

  test("a read-only row (label + value) stays one element, read together", () => {
    expect(rowAccessibility({ pressable: false, control: false })).toEqual({
      group: true,
      textButton: false,
    });
  });
});
