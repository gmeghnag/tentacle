/**
 * The chat header's "…" menu (owner feedback #3, mockup `Conversation`'s
 * "Session menu" button). Only phone-local actions — reading what is already on
 * screen; anything that needs the computer (rename, archive, new session) is a
 * separate task (owner decision 2). Pure and React-free (AGENTS §7):
 * `SessionScreen.tsx` draws the sheet and copies the returned text.
 */
import type { Row } from "./transcript-rows.ts";

export type SessionMenuId = "copy-last" | "copy-all";

export interface SessionMenuAction {
  readonly id: SessionMenuId;
  readonly label: string;
  /** What the action copies (already decided: the screen never re-reads rows). */
  readonly text: string;
}

/** The conversation's words: the person's prompts and the answers (no tools, no reasoning). */
function said(rows: readonly Row[]): readonly { who: "You" | "tentacle"; text: string }[] {
  const out: { who: "You" | "tentacle"; text: string }[] = [];
  for (const row of rows) {
    if ((row.kind === "user" || row.kind === "assistant") && row.text.trim() !== "") {
      out.push({ who: row.kind === "user" ? "You" : "tentacle", text: row.text });
    }
  }
  return out;
}

/** The menu's actions, each only when it has something to copy. */
export function sessionMenu(rows: readonly Row[]): readonly SessionMenuAction[] {
  const words = said(rows);
  const actions: SessionMenuAction[] = [];
  const last = [...words].reverse().find((line) => line.who === "tentacle");
  if (last !== undefined) {
    actions.push({ id: "copy-last", label: "Copy last answer", text: last.text });
  }
  if (words.length > 0) {
    actions.push({
      id: "copy-all",
      label: "Copy conversation",
      text: words.map((line) => `${line.who}: ${line.text}`).join("\n\n"),
    });
  }
  return actions;
}
