/**
 * The line-editing tail (docs/feat/app-decomposition.md S12): what a chunk that
 * every layer above PASSED does to the input line, as effects — data, run
 * through the same `executeEffects`/`KeyHost` as the 13 pure layers.
 *
 * It is not an entry in `PURE_LAYERS`: it runs after the mouse layer (the
 * router's continuation, `layers.ts`), and only when the mouse layer passed —
 * so it can never claim a chunk a layer above meant to swallow. It is the
 * terminal consumer: there is no verdict, every chunk that reaches it is its.
 *
 * Line editing works while idle AND while a turn runs (a task can be typed and
 * queued for steering). The routing is `resolveLineInput`'s; this module adds
 * the three decisions that used to live inline in `App.tsx`: DOWN's walk into
 * the dock (`downEntersList`), history recall with its no-op guard
 * (`historyStep`), and Backspace's chip rule (attachments-tui decision 13).
 */
import type { Key } from "ink";
import { type DockFocus, downEntersList } from "../background-focus.ts";
import { recall } from "../history.ts";
import { resolveLineInput } from "../input-actions.ts";
import type { KeyEffect } from "./effects.ts";

/**
 * What the tail reads, built by the App at the event, AFTER the router's effects
 * and the mouse layer ran — exactly when the inline tail read the same sources:
 * `value`/`cursor` are the frame's render values (a bracket the mouse layer just
 * restored is not in them, as before), the rest are the live refs read then.
 */
export interface LineSnapshot {
  readonly char: string;
  readonly key: Key;
  readonly value: string;
  readonly cursor: number;
  /** The history walk: `index === items.length` is the draft slot. */
  readonly history: {
    readonly items: readonly string[];
    readonly index: number;
    readonly draft: string;
  };
  readonly paletteOpen: boolean;
  /** The dock's pill is on screen (`dockVisible()`). */
  readonly dockVisible: boolean;
  readonly dockFocus: DockFocus;
  /** Chips on the attachment draft. */
  readonly chipCount: number;
  /** The queued row ↑ on an empty input pulls back (`pullBackTarget`), if any. */
  readonly pullBack: { readonly id: string; readonly text: string } | null;
}

/** One history move: the new position, the saved draft, and the text to show. */
export interface HistoryMove {
  readonly index: number;
  readonly draft: string;
  /** The field's new text, or `null` when the recall moved nothing. */
  readonly set: string | null;
}

/**
 * Step the history by `dir` from `value` (the field as drawn). On the draft slot
 * the live value IS the draft (saved by the first Up); inside history the saved
 * draft is what a Down past the newest restores. A no-op recall (Up with an
 * empty history, Up at the oldest) must not touch the field — `set: null` — or a
 * mid-buffer cursor would jump to the end. Otherwise the field is set, and the
 * cursor lands at the end of the recalled entry (shell convention).
 */
export function historyStep(
  history: LineSnapshot["history"],
  dir: -1 | 1,
  value: string,
): HistoryMove {
  const onDraftSlot = history.index >= history.items.length;
  const res = recall(
    { items: history.items, index: history.index },
    dir,
    onDraftSlot ? value : history.draft,
  );
  const unchanged = res.value === value && res.index === history.index;
  return { index: res.index, draft: res.draft, set: unchanged ? null : res.value };
}

/** The effects for one chunk that reached line editing, in execution order. */
export function resolveLineEffects(snap: LineSnapshot): readonly KeyEffect[] {
  const { key, value, cursor } = snap;
  const action = resolveLineInput(snap.char, key, { value, cursor });
  // DOWN's fourth meaning (mockup 02's table): on the draft slot, with nothing
  // below to move to and no history walk left, it walks into the dock.
  if (
    key.downArrow &&
    !key.shift &&
    (action.kind === "history" || action.kind === "moveVertical") &&
    downEntersList({
      action: action.kind,
      onDraftSlot: snap.history.index >= snap.history.items.length,
      paletteOpen: snap.paletteOpen,
      visible: snap.dockVisible,
      focus: snap.dockFocus,
    })
  ) {
    return [{ kind: "dockDown" }];
  }
  switch (action.kind) {
    case "moveVertical":
      return [{ kind: "fieldMoveVertical", dir: action.dir, extend: action.extend }];
    case "history": {
      // ↑ on an EMPTY input at the draft slot, with a queued row of mine:
      // pull it back to edit (docs/feat/queue-unqueue.md) — before history.
      if (
        action.dir === -1 &&
        value === "" &&
        snap.pullBack !== null &&
        snap.history.index >= snap.history.items.length
      ) {
        return [{ kind: "pullBackQueued", id: snap.pullBack.id, text: snap.pullBack.text }];
      }
      const move = historyStep(snap.history, action.dir, value);
      const cursorWrite: KeyEffect = {
        kind: "setHistoryCursor",
        index: move.index,
        draft: move.draft,
      };
      return move.set === null
        ? [cursorWrite]
        : [cursorWrite, { kind: "fieldSet", text: move.set }];
    }
    case "scroll":
      return [{ kind: "scroll", dir: action.dir }];
    case "pasteClipboard":
      return [{ kind: "pasteClipboard" }];
    case "newline":
      // A trailing `\` before the cursor is a line continuation, not a submit.
      return [{ kind: "fieldDeleteBack" }, { kind: "fieldInsert", text: "\n" }];
    case "submit":
      return [{ kind: "submit", text: value }];
    case "moveWord":
      return [{ kind: "fieldMoveWord", dir: action.dir, extend: action.extend }];
    case "moveCursor":
      return [{ kind: "fieldMoveCursor", delta: action.delta, extend: action.extend }];
    case "moveLine":
      return [{ kind: "fieldMoveLine", edge: action.edge, extend: action.extend }];
    case "deleteBack":
      // Backspace on an EMPTY input with chips removes the last one
      // (docs/feat/attachments-tui.md decision 13): the smallest control.
      if (value === "" && cursor === 0 && snap.chipCount > 0) {
        return [{ kind: "removeLastChip" }];
      }
      return [{ kind: "fieldDeleteBack" }];
    case "deleteWord":
      return [{ kind: "fieldDeleteWord", dir: action.dir }];
    case "insert":
      return [{ kind: "fieldInsert", text: action.text }];
    case "none":
      return [];
  }
}
