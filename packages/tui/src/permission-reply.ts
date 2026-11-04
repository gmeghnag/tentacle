/**
 * The permission dialog's keys and its reply field, pure and React-free
 * (docs/feat/permission-reply.md): "No, let's talk about it" opens a text
 * field whose text goes to the model with the refusal. Every key decision is
 * here — the menu's shortcuts, the field's editing (`resolveLineInput` over
 * `editor.ts`, as the main input), the clip to `maxChars` — so `App` only
 * executes the returned action and `PermissionPrompt` only draws the view.
 */
import type { AnswerLostCause, PermissionResponse } from "@tentacle/core";
import type { Key } from "ink";
import {
  EMPTY_EDITOR,
  type EditorState,
  deleteBack,
  deleteWord,
  insert,
  moveCursor,
  moveLine,
  moveVertical,
  moveWord,
  selectionRange,
} from "./editor.ts";
import { resolveLineInput } from "./input-actions.ts";
import { type InputRow, inputRender } from "./input-view.ts";
import type { PermissionChoice } from "./permission-ui.ts";

/**
 * The dialog's mode: the menu (with the field's draft, kept while the same
 * request is up), or the field open.
 */
export type ReplyMode =
  | { readonly mode: "menu"; readonly draft?: EditorState }
  | { readonly mode: "reply"; readonly editor: EditorState };

export const MENU: ReplyMode = { mode: "menu" };

/** What `App` executes for a key. */
export type DialogAction =
  | { readonly kind: "none" }
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "answer"; readonly response: PermissionResponse }
  /** Ctrl+C: stop the turn (App dismisses + aborts only with a turn shown). */
  | { readonly kind: "stop" }
  /** Ctrl+V in the field: App reads the clipboard into it (`insertReply`). */
  | { readonly kind: "pasteClipboard" };

export interface DialogStep {
  readonly state: ReplyMode;
  readonly action: DialogAction;
}

export interface DialogContext {
  readonly choices: readonly PermissionChoice[];
  readonly selected: number;
  /** The request's `reply.maxChars` (0 when it takes none). */
  readonly maxChars: number;
}

/** The field's prompt row, footer and visible rows. */
export const REPLY_PROMPT = "Tell the agent why, or what to do instead:";
const REPLY_FOOTER = " enter send · esc back · empty = No";
export const MENU_FOOTER = " ↑↓ choose · enter confirm · y/a/n · esc deny";
export const MENU_FOOTER_REPLY = " ↑↓ choose · enter confirm · y/a/n/t · esc deny";
export const MAX_REPLY_ROWS = 4;

const NONE: DialogAction = { kind: "none" };

/** The draft the dialog holds (menu or field), "" when none. */
export function draftOf(state: ReplyMode): string {
  return state.mode === "reply" ? state.editor.value : (state.draft?.value ?? "");
}

/** Insert `text` at the cursor, clipped so the field never exceeds `maxChars`. */
export function insertReply(state: ReplyMode, text: string, maxChars: number): ReplyMode {
  if (state.mode !== "reply") {
    return state;
  }
  const editor = state.editor;
  const range = selectionRange(editor);
  const kept = editor.value.length - (range ? range[1] - range[0] : 0);
  const room = Math.max(0, maxChars - kept);
  const clipped = [...text].reduce(
    (acc, ch) => (acc.length + ch.length <= room ? acc + ch : acc),
    "",
  );
  return clipped === "" && !range ? state : { mode: "reply", editor: insert(editor, clipped) };
}

function open(state: ReplyMode): ReplyMode {
  return {
    mode: "reply",
    editor: state.mode === "menu" ? (state.draft ?? EMPTY_EDITOR) : state.editor,
  };
}

/** One key while the dialog is up. */
export function stepPermissionKey(
  state: ReplyMode,
  char: string,
  key: Key,
  ctx: DialogContext,
): DialogStep {
  if (key.ctrl && char === "c") {
    return { state, action: { kind: "stop" } };
  }
  if (state.mode === "reply") {
    return stepField(state, char, key, ctx);
  }
  const { choices, selected } = ctx;
  const n = choices.length;
  const replyable = choices.some((c) => c.reply === true);
  if (key.upArrow) {
    return { state, action: { kind: "select", index: (selected - 1 + n) % n } };
  }
  if (key.downArrow) {
    return { state, action: { kind: "select", index: (selected + 1) % n } };
  }
  if (key.return) {
    const choice = choices[selected];
    if (choice?.reply) {
      return { state: open(state), action: NONE };
    }
    return { state, action: { kind: "answer", response: choice?.response ?? { allowed: false } } };
  }
  if (char === "y") {
    return { state, action: { kind: "answer", response: { allowed: true, scope: "once" } } };
  }
  if (char === "a") {
    const response = choices[1]?.response ?? { allowed: true, scope: "session" };
    return { state, action: { kind: "answer", response } };
  }
  if (char === "t" && replyable) {
    return { state: open(state), action: NONE };
  }
  if (char === "n" || key.escape) {
    return { state, action: { kind: "answer", response: { allowed: false } } };
  }
  return { state, action: NONE };
}

function stepField(
  state: Extract<ReplyMode, { mode: "reply" }>,
  char: string,
  key: Key,
  ctx: DialogContext,
): DialogStep {
  const editor = state.editor;
  if (key.escape) {
    // Back to the menu; the draft stays for this request.
    return { state: { mode: "menu", draft: editor }, action: NONE };
  }
  const edit = (next: EditorState): DialogStep => ({
    state: { mode: "reply", editor: next },
    action: NONE,
  });
  const action = resolveLineInput(char, key, { value: editor.value, cursor: editor.cursor });
  switch (action.kind) {
    case "submit": {
      const text = editor.value;
      // Empty or blank: a plain No (owner Q2). The client normalizes the rest.
      const response: PermissionResponse =
        text.trim() === "" ? { allowed: false } : { allowed: false, message: text };
      return { state, action: { kind: "answer", response } };
    }
    case "newline":
      // As the main input: the trailing `\` becomes the line break.
      return {
        state: insertReply({ mode: "reply", editor: deleteBack(editor) }, "\n", ctx.maxChars),
        action: NONE,
      };
    case "insert":
      return { state: insertReply(state, action.text, ctx.maxChars), action: NONE };
    case "pasteClipboard":
      return { state, action: { kind: "pasteClipboard" } };
    case "moveVertical":
      return edit(moveVertical(editor, action.dir, action.extend));
    case "moveWord":
      return edit(moveWord(editor, action.dir, action.extend));
    case "moveCursor":
      return edit(moveCursor(editor, action.delta, action.extend));
    case "moveLine":
      return edit(moveLine(editor, action.edge, action.extend));
    case "deleteBack":
      return edit(deleteBack(editor));
    case "deleteWord":
      return edit(deleteWord(editor, action.dir));
    // No history and no transcript scroll inside the dialog.
    default:
      return { state, action: NONE };
  }
}

export interface ReplyView {
  readonly prompt: string;
  /** The field: at most `MAX_REPLY_ROWS`, scrolled to the cursor. */
  readonly rows: readonly InputRow[];
  readonly footer: string;
}

/** The open field as rows (`inputRender`, like the main input), with its footer and counter. */
export function replyView(state: ReplyMode, columns: number, maxChars: number): ReplyView {
  const editor = state.mode === "reply" ? state.editor : EMPTY_EDITOR;
  const width = Math.max(10, columns - 2);
  const { rows } = inputRender(editor.value, editor.cursor, editor.anchor, MAX_REPLY_ROWS, width);
  const length = editor.value.length;
  // The counter from 80 % of the limit.
  const counter = maxChars > 0 && length * 5 >= maxChars * 4 ? ` · ${length}/${maxChars}` : "";
  return { prompt: REPLY_PROMPT, rows, footer: `${REPLY_FOOTER}${counter}` };
}

/** A refused call's row head (owner Q-A: no label, no quotes). */
export const DENIED_LABEL = "✗ Denied";
const DENIED_PREFIX = `${DENIED_LABEL} · `;

/**
 * A refused call's body when the person replied: `✗ Denied · <text>`, its
 * continuation lines indented under the text (trailing newlines dropped).
 */
export function denialReplyLines(reply: string): string[] {
  const indent = " ".repeat(DENIED_PREFIX.length);
  return reply
    .replace(/\n+$/, "")
    .split("\n")
    .map((line, i) => (i === 0 ? `${DENIED_PREFIX}${line}` : `${indent}${line}`));
}

/**
 * Why a draft went back to the main input, and what the notice says: closed
 * here (`withdrawn` / `approved` / `answered`), or a sent reply the runtime
 * handed back (`AnswerLostCause`) — each told as it really happened.
 */
export type OrphanCause = "withdrawn" | "approved" | "answered" | AnswerLostCause;

export function orphanNotice(cause: OrphanCause): string {
  switch (cause) {
    case "approved":
      return "_auto-accept on: the request was approved; your reply is back in the input_";
    case "answered":
      return "_your reply was not sent (you answered without it): it is back in the input_";
    case "settled":
      return "_your reply did not reach the agent (the request was already settled): it is back in the input_";
    case "session-lost":
      return "_your reply may not have reached the agent (the session was lost): it is back in the input_";
    case "failed":
      return "_your reply could not be sent (the send failed): it is back in the input_";
    case "unreplyable":
      return "_your reply was not sent (this agent does not take a reply): it is back in the input_";
    default:
      return "_your reply was not sent (the request was withdrawn): it is back in the input_";
  }
}
