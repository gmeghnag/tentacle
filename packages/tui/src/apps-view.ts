import { appStateOf } from "@tentacle/client";
/**
 * The TUI's view of the session's published apps
 * (docs/feat/session-apps-publish.md D10): the `/apps` panel's rows and keys,
 * the status line's words and the quit warning. Pure: the rows are already
 * bounded and sanitized by the client.
 *
 * Meaning is never carried by colour alone: every state is a WORD.
 */
import type { AppRow } from "@tentacle/protocol";
import { paletteWindow } from "./commands.ts";
import type { PanelKeyState, PanelView, PanelViewRow } from "./tree-panel.ts";

export { appStateOf };

/** How many apps are public right now (a renewing one still is). */
export function liveAppCount(rows: readonly AppRow[] | undefined): number {
  return (rows ?? []).filter((row) => {
    const state = appStateOf(row.state);
    return state === "up" || state === "renewing";
  }).length;
}

/** The status line's words: `2 apps`, `app down`; null with no app. */
export function appsStatusLabel(rows: readonly AppRow[] | undefined): string | null {
  if (rows === undefined || rows.length === 0) return null;
  const off = rows.length - liveAppCount(rows);
  if (off > 0) return off === 1 ? "app down" : `${off} apps down`;
  return rows.length === 1 ? "1 app" : `${rows.length} apps`;
}

/** What a quit that ENDS the session takes with it, or null. */
export function appsQuitText(live: number): string | null {
  if (live <= 0) return null;
  return `quitting takes ${live} live ${live === 1 ? "app" : "apps"} offline`;
}

/** What the user is told after a stop. */
export function appStopNotice(
  app: string,
  result: { readonly ok: boolean; readonly reason?: string },
): string {
  if (!result.ok) return `_${app} was not stopped: ${result.reason ?? "the daemon refused"}_`;
  return result.reason ? `_Stopped ${app} (${result.reason})._` : `_Stopped ${app}._`;
}

const fit = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;

const note = (text: string, width: number): PanelView => ({
  title: "Apps",
  rows: [{ text: fit(`  ${text}`, width), kind: "note", selected: false }],
  hint: "esc close",
  start: 0,
});

export const clampCursor = (cursor: number, count: number): number =>
  count <= 0 ? 0 : Math.min(Math.max(0, cursor), count - 1);

/** The `/apps` panel: two rows per app — title and state, then URL and reason. */
export function appsView(
  rows: readonly AppRow[] | undefined,
  cursor: number,
  width: number,
  maxBody: number,
): PanelView {
  if (rows === undefined) return note("not reported by this session yet", width);
  if (rows.length === 0) return note("No published apps in this session.", width);
  const at = clampCursor(cursor, rows.length);
  const window = paletteWindow(rows.length, at, Math.max(1, Math.floor(maxBody / 2)));
  const out: PanelViewRow[] = [];
  for (let i = window.start; i < window.end; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const selected = i === at;
    const state = appStateOf(row.state);
    out.push({
      text: fit(`${selected ? "▸" : " "} ${state} · ${row.title}`, width),
      kind: "head",
      selected,
    });
    out.push({
      text: fit(`    ${row.url}${row.reason ? ` — ${row.reason}` : ""}`, width),
      kind: "child",
      selected: false,
    });
  }
  const more =
    window.end - window.start < rows.length
      ? ` · ${window.start + 1}–${window.end} of ${rows.length}`
      : "";
  return {
    title: `Apps (${rows.length})`,
    rows: out,
    hint: `↑↓ select · s stop · esc close${more}`,
    start: window.start,
  };
}

export type AppsKeyAction = "up" | "down" | "stop" | "close" | "none";

export function appsKey(input: string, key: PanelKeyState): AppsKeyAction {
  if (key.escape === true || input === "q") return "close";
  if (key.upArrow === true) return "up";
  if (key.downArrow === true) return "down";
  return input === "s" ? "stop" : "none";
}

/** The cursor after a move, wrapping. */
export function appsMove(cursor: number, action: "up" | "down", count: number): number {
  if (count <= 0) return 0;
  const at = clampCursor(cursor, count);
  return action === "up" ? (at - 1 + count) % count : (at + 1) % count;
}
