/**
 * The line-editing tail (docs/feat/app-decomposition.md S12, `keys/line-layer.ts`):
 * what a chunk that every layer above passed DOES to the input line, as data.
 *
 * Before S12 this was ~105 inline lines at the end of `App.tsx`'s `useInput`
 * (history recall + its no-op guard, DOWN's walk into the dock, the 14-arm
 * switch, Backspace's chip rule) — reachable only through a rendered App. These
 * tests pin each decision on its own; `keys-execute.test.ts` pins that each
 * effect reaches the right host method.
 */
import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import type { KeyEffect } from "../src/keys/effects.ts";
import { type LineSnapshot, historyStep, resolveLineEffects } from "../src/keys/line-layer.ts";

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function snap(
  over: Partial<Omit<LineSnapshot, "key">> & { key?: Partial<Key> } = {},
): LineSnapshot {
  const { key, ...rest } = over;
  return {
    char: "",
    value: "",
    cursor: 0,
    history: { items: [], index: 0, draft: "" },
    paletteOpen: false,
    dockVisible: false,
    dockFocus: { kind: "input" },
    chipCount: 0,
    ...rest,
    key: { ...NO_KEY, ...key },
  };
}

const kinds = (effects: readonly KeyEffect[]): string[] => effects.map((e) => e.kind);

describe("resolveLineEffects — one action, its effects", () => {
  test("a printable chunk inserts it", () => {
    expect(resolveLineEffects(snap({ char: "hi" }))).toEqual([{ kind: "fieldInsert", text: "hi" }]);
  });

  test("a chunk nothing claims does nothing", () => {
    expect(resolveLineEffects(snap({ key: { escape: true } }))).toEqual([]);
  });

  test("Enter submits the value this frame drew", () => {
    expect(resolveLineEffects(snap({ value: "go", cursor: 2, key: { return: true } }))).toEqual([
      { kind: "submit", text: "go" },
    ]);
  });

  test("a trailing `\\` + Enter is a newline: delete the `\\`, THEN insert", () => {
    expect(resolveLineEffects(snap({ value: "a\\", cursor: 2, key: { return: true } }))).toEqual([
      { kind: "fieldDeleteBack" },
      { kind: "fieldInsert", text: "\n" },
    ]);
  });

  test("PgUp / PgDn scroll the transcript", () => {
    expect(resolveLineEffects(snap({ key: { pageUp: true } }))).toEqual([
      { kind: "scroll", dir: "pageUp" },
    ]);
    expect(resolveLineEffects(snap({ key: { pageDown: true } }))).toEqual([
      { kind: "scroll", dir: "pageDown" },
    ]);
  });

  test("Ctrl+V reads the clipboard", () => {
    expect(resolveLineEffects(snap({ char: "v", key: { ctrl: true } }))).toEqual([
      { kind: "pasteClipboard" },
    ]);
  });

  test("cursor, word and line moves carry their direction and extend flag", () => {
    expect(resolveLineEffects(snap({ key: { leftArrow: true, shift: true } }))).toEqual([
      { kind: "fieldMoveCursor", delta: -1, extend: true },
    ]);
    expect(resolveLineEffects(snap({ key: { rightArrow: true, meta: true } }))).toEqual([
      { kind: "fieldMoveWord", dir: 1, extend: false },
    ]);
    expect(resolveLineEffects(snap({ char: "e", key: { ctrl: true } }))).toEqual([
      { kind: "fieldMoveLine", edge: "end", extend: false },
    ]);
  });

  test("word delete carries its direction", () => {
    expect(resolveLineEffects(snap({ char: "d", key: { meta: true } }))).toEqual([
      { kind: "fieldDeleteWord", dir: 1 },
    ]);
  });

  test("Up inside a multi-line buffer moves the cursor, not history", () => {
    expect(
      resolveLineEffects(
        snap({
          value: "a\nb",
          cursor: 3,
          history: { items: ["old"], index: 1, draft: "" },
          key: { upArrow: true },
        }),
      ),
    ).toEqual([{ kind: "fieldMoveVertical", dir: -1, extend: false }]);
  });
});

describe("resolveLineEffects — Backspace's chip rule (attachments-tui decision 13)", () => {
  const bs = { delete: true };

  test("an EMPTY field at 0 with chips removes the last chip, and nothing else", () => {
    expect(resolveLineEffects(snap({ chipCount: 2, key: bs }))).toEqual([
      { kind: "removeLastChip" },
    ]);
  });

  test("with no chip it is a plain Backspace", () => {
    expect(resolveLineEffects(snap({ chipCount: 0, key: bs }))).toEqual([
      { kind: "fieldDeleteBack" },
    ]);
  });

  test("with text in the field the chips are safe: it deletes text", () => {
    expect(resolveLineEffects(snap({ value: "x", cursor: 1, chipCount: 1, key: bs }))).toEqual([
      { kind: "fieldDeleteBack" },
    ]);
  });

  test("text after a cursor at 0 still protects the chips (both conditions)", () => {
    expect(resolveLineEffects(snap({ value: "x", cursor: 0, chipCount: 1, key: bs }))).toEqual([
      { kind: "fieldDeleteBack" },
    ]);
  });
});

describe("historyStep — recall + the no-op guard", () => {
  test("Up with an empty history moves nothing and does NOT touch the field", () => {
    const step = historyStep({ items: [], index: 0, draft: "" }, -1, "mid");
    expect(step).toEqual({ index: 0, draft: "mid", set: null });
  });

  test("the first Up saves the live value as the draft and shows the newest entry", () => {
    const step = historyStep({ items: ["a", "b"], index: 2, draft: "stale" }, -1, "live");
    expect(step).toEqual({ index: 1, draft: "live", set: "b" });
  });

  test("Down past the newest restores the SAVED draft, not the shown value", () => {
    const step = historyStep({ items: ["a", "b"], index: 1, draft: "live" }, 1, "b");
    expect(step).toEqual({ index: 2, draft: "live", set: "live" });
  });

  test("Up at the oldest entry is a no-op: the field is left alone", () => {
    const step = historyStep({ items: ["a", "b"], index: 0, draft: "live" }, -1, "a");
    expect(step.set).toBeNull();
    expect(step.index).toBe(0);
  });

  test("a recall whose text equals the field but MOVES the index still sets it", () => {
    // The guard needs BOTH the same text and the same index: entering history
    // onto an entry equal to the draft moves the cursor to the end (shell rule).
    const step = historyStep({ items: ["x"], index: 1, draft: "" }, -1, "x");
    expect(step).toEqual({ index: 0, draft: "x", set: "x" });
  });

  test("as effects: the cursor write comes first, the field write only when due", () => {
    expect(
      resolveLineEffects(
        snap({ history: { items: ["a"], index: 1, draft: "" }, key: { upArrow: true } }),
      ),
    ).toEqual([
      { kind: "setHistoryCursor", index: 0, draft: "" },
      { kind: "fieldSet", text: "a" },
    ]);
    expect(
      kinds(
        resolveLineEffects(
          snap({ history: { items: [], index: 0, draft: "" }, key: { upArrow: true } }),
        ),
      ),
    ).toEqual(["setHistoryCursor"]);
  });
});

describe("resolveLineEffects — DOWN's walk into the dock (downEntersList)", () => {
  const down = { downArrow: true };
  const onDraft = { items: ["a"], index: 1, draft: "" };

  test("the draft slot, a visible pill, input focus: DOWN enters the dock and only that", () => {
    expect(resolveLineEffects(snap({ history: onDraft, dockVisible: true, key: down }))).toEqual([
      { kind: "dockDown" },
    ]);
  });

  test("the pinned dropdown (list + typing) is 'the input' too", () => {
    const step = resolveLineEffects(
      snap({
        history: onDraft,
        dockVisible: true,
        dockFocus: { kind: "list", typing: true } as LineSnapshot["dockFocus"],
        key: down,
      }),
    );
    expect(step).toEqual([{ kind: "dockDown" }]);
  });

  test("Shift+DOWN never enters the dock (it extends a selection)", () => {
    expect(
      kinds(
        resolveLineEffects(
          snap({ history: onDraft, dockVisible: true, key: { ...down, shift: true } }),
        ),
      ),
    ).toEqual(["fieldMoveVertical"]);
  });

  test("no visible dock: DOWN is history's", () => {
    expect(kinds(resolveLineEffects(snap({ history: onDraft, key: down })))).toEqual([
      "setHistoryCursor",
    ]);
  });

  test("inside history (not the draft slot): DOWN walks history", () => {
    expect(
      kinds(
        resolveLineEffects(
          snap({ history: { items: ["a"], index: 0, draft: "d" }, dockVisible: true, key: down }),
        ),
      ),
    ).toEqual(["setHistoryCursor", "fieldSet"]);
  });

  test("a line below the cursor: DOWN moves inside the buffer", () => {
    expect(
      kinds(
        resolveLineEffects(
          snap({ value: "a\nb", cursor: 0, history: onDraft, dockVisible: true, key: down }),
        ),
      ),
    ).toEqual(["fieldMoveVertical"]);
  });

  test("an open palette keeps DOWN (defence in depth: its layer runs first)", () => {
    expect(
      kinds(
        resolveLineEffects(
          snap({ history: onDraft, dockVisible: true, paletteOpen: true, key: down }),
        ),
      ),
    ).toEqual(["setHistoryCursor"]);
  });

  test("the pill already focused: DOWN is history's, not the dock's", () => {
    expect(
      kinds(
        resolveLineEffects(
          snap({ history: onDraft, dockVisible: true, dockFocus: { kind: "pill" }, key: down }),
        ),
      ),
    ).toEqual(["setHistoryCursor"]);
  });
});
