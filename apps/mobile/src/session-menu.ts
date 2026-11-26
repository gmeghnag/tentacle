/**
 * The chat header's "…" menu (owner feedback #3, mockup `Conversation`'s
 * "Session menu" button). It opens with **Session info** (docs/feat/
 * mobile-session-info.md) — a READ of what the session is running, which owner
 * decision 2 does not exclude — then the phone-local copy actions. Anything that
 * needs the computer (archive, new session) is still a separate task. Pure and
 * React-free (AGENTS §7): `SessionScreen.tsx` draws the sheet and copies the
 * returned text.
 */
import { messageText } from "./message-copy.ts";
import type { Row } from "./transcript-rows.ts";

export type SessionMenuId = "info" | "scheduled" | "copy-last" | "copy-all";

export interface SessionMenuAction {
  readonly id: SessionMenuId;
  readonly label: string;
  /** What the action copies (already decided: the screen never re-reads rows). */
  readonly text: string;
}

/**
 * The conversation's words: the person's prompts and the answers (no tools, no
 * reasoning). What each one's text IS comes from `messageText` — the same rule a
 * long-press uses (docs/feat/mobile-copy-text.md D1), so "Copy last answer" and
 * copying that message by hand can never give different bytes.
 *
 * A fired wake stays in here (`messageText` does not apply the wake rule, which
 * needs a clock): "Copy conversation" has always carried it.
 */
function said(rows: readonly Row[]): readonly { who: "You" | "tentacle"; text: string }[] {
  const out: { who: "You" | "tentacle"; text: string }[] = [];
  for (const row of rows) {
    if (row.kind !== "user" && row.kind !== "assistant") {
      continue;
    }
    const text = messageText(row);
    if (text !== null && text.trim() !== "") {
      out.push({ who: row.kind === "user" ? "You" : "tentacle", text });
    }
  }
  return out;
}

/**
 * The menu's actions: **Session info** always first (it needs nothing to be on
 * screen), then **Scheduled wakes** when the daemon reports armed wakes
 * (docs/feat/mobile-hub.md H4a: the one path to the wakes today — the hub's own
 * Scheduled item lands on the same revealed sheet), then each copy action only
 * when it has something to copy.
 */
export function sessionMenu(rows: readonly Row[], wakes = 0): readonly SessionMenuAction[] {
  const words = said(rows);
  const actions: SessionMenuAction[] = [{ id: "info", label: "Session info", text: "" }];
  if (wakes > 0) {
    actions.push({ id: "scheduled", label: "Scheduled wakes", text: "" });
  }
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
