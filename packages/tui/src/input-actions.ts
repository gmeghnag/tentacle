/**
 * Input routing for the prompt line, as a pure function: it maps a keypress
 * (Ink's `char` + `key`) and the current buffer to a single `InputAction`. No
 * React, no refs, no side effects — so every routing decision (the subtle ones:
 * Up moving the cursor vs. recalling history at the buffer edge; `\`+Enter as a
 * newline vs. submit) is understood and unit-tested in one place. `App` only
 * executes the returned action; stateful mechanics (history recall, scrolling,
 * async clipboard) stay there because they are inherently stateful.
 */
import type { Key } from "ink";
import { sanitizeInsert } from "./paste.ts";

export type InputAction =
  | { readonly kind: "none" }
  | { readonly kind: "moveVertical"; readonly dir: -1 | 1; readonly extend: boolean }
  | { readonly kind: "history"; readonly dir: -1 | 1 }
  | { readonly kind: "scroll"; readonly dir: "pageUp" | "pageDown" }
  | { readonly kind: "pasteClipboard" }
  | { readonly kind: "submit" }
  | { readonly kind: "newline" }
  | { readonly kind: "moveWord"; readonly dir: -1 | 1; readonly extend: boolean }
  | { readonly kind: "moveCursor"; readonly delta: -1 | 1; readonly extend: boolean }
  | { readonly kind: "moveLine"; readonly edge: "start" | "end"; readonly extend: boolean }
  | { readonly kind: "deleteBack" }
  | { readonly kind: "deleteWord"; readonly dir: -1 | 1 }
  | { readonly kind: "insert"; readonly text: string };

export interface InputContext {
  readonly value: string;
  readonly cursor: number;
}

/**
 * Resolve the prompt-line action for a keypress. Reached only after the App's
 * modal/demux layers (permission dialog, bracketed paste, mouse reports,
 * palette) have had their turn — this is purely the line-editing routing.
 *
 * Order matters and mirrors the historical if-chain exactly: Up/Down (vertical
 * move, falling back to history only at the first/last line; Shift never
 * recalls history), PgUp/PgDn (scroll), Ctrl+V (paste), Enter (newline on a
 * trailing `\`, else submit), word-jump, shift-select, plain arrows, Ctrl+A/E
 * (line start/end), word delete (Option+Backspace, Ctrl+W, Alt+D), backspace,
 * then printable insert.
 */
export function resolveLineInput(char: string, key: Key, ctx: InputContext): InputAction {
  const { value, cursor } = ctx;
  const onFirstLine = value.lastIndexOf("\n", cursor - 1) === -1;
  const onLastLine = value.indexOf("\n", cursor) === -1;

  if (key.upArrow) {
    if (key.shift) {
      return { kind: "moveVertical", dir: -1, extend: true };
    }
    if (!onFirstLine) {
      return { kind: "moveVertical", dir: -1, extend: false };
    }
    return { kind: "history", dir: -1 };
  }
  if (key.downArrow) {
    if (key.shift) {
      return { kind: "moveVertical", dir: 1, extend: true };
    }
    if (!onLastLine) {
      return { kind: "moveVertical", dir: 1, extend: false };
    }
    return { kind: "history", dir: 1 };
  }
  if (key.pageUp) {
    return { kind: "scroll", dir: "pageUp" };
  }
  if (key.pageDown) {
    return { kind: "scroll", dir: "pageDown" };
  }
  if (key.ctrl && char === "v") {
    return { kind: "pasteClipboard" };
  }
  if (key.return) {
    // A `\` immediately before the cursor is a line continuation, not a submit
    // (terminal-independent multi-line entry; Shift/Alt+Enter aren't reliably
    // distinguishable in a TTY).
    if (value.slice(0, cursor).endsWith("\\")) {
      return { kind: "newline" };
    }
    return { kind: "submit" };
  }
  // Word jump: Option/Alt + arrows (macOS) or Ctrl + arrows (Linux), with a
  // macOS fallback where Option sends a meta char (ESC b / ESC f).
  if ((key.ctrl || key.meta) && key.leftArrow) {
    return { kind: "moveWord", dir: -1, extend: key.shift };
  }
  if ((key.ctrl || key.meta) && key.rightArrow) {
    return { kind: "moveWord", dir: 1, extend: key.shift };
  }
  if (key.meta && char === "b") {
    return { kind: "moveWord", dir: -1, extend: key.shift };
  }
  if (key.meta && char === "f") {
    return { kind: "moveWord", dir: 1, extend: key.shift };
  }
  // Shift + arrows: character selection.
  if (key.shift && key.leftArrow) {
    return { kind: "moveCursor", delta: -1, extend: true };
  }
  if (key.shift && key.rightArrow) {
    return { kind: "moveCursor", delta: 1, extend: true };
  }
  if (key.leftArrow) {
    return { kind: "moveCursor", delta: -1, extend: false };
  }
  if (key.rightArrow) {
    return { kind: "moveCursor", delta: 1, extend: false };
  }
  // Line start/end: Ctrl+A / Ctrl+E (readline); Ink 5.0.1 does not surface
  // Home/End through useInput. `key.shift` extends the selection if reported.
  if (key.ctrl && char === "a") {
    return { kind: "moveLine", edge: "start", extend: key.shift };
  }
  if (key.ctrl && char === "e") {
    return { kind: "moveLine", edge: "end", extend: key.shift };
  }
  // Word delete. Ink reports \x7f (plain Backspace) as `delete` and \x08 as
  // `backspace`; ESC+either (Option/Alt+Backspace) adds `meta` and is
  // unambiguous. A bare \x08 is Ctrl+H / Ctrl+Backspace, or plain Backspace on
  // a terminal set to send ^H: it deletes ONE char (never more than intended),
  // see below. Ctrl+W is readline's (and iTerm2's Option+Backspace preset).
  // Alt/Option+D deletes the next word.
  if (key.meta && (key.backspace || key.delete)) {
    return { kind: "deleteWord", dir: -1 };
  }
  if (key.ctrl && char === "w") {
    return { kind: "deleteWord", dir: -1 };
  }
  if (key.meta && char === "d") {
    return { kind: "deleteWord", dir: 1 };
  }
  if (key.backspace || key.delete) {
    return { kind: "deleteBack" };
  }
  // Insert only genuine printable text; never a control/modified key.
  if (char && !key.ctrl && !key.meta && !key.escape && !key.tab) {
    const text = sanitizeInsert(char);
    if (text) {
      return { kind: "insert", text };
    }
  }
  return { kind: "none" };
}
