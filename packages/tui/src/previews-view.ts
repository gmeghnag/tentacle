/**
 * The TUI's view of the session's container previews
 * (docs/feat/session-apps-container-ports.md S4): the `/previews` panel's rows,
 * keys and notices. Pure: the rows are already bounded and sanitized by the
 * client. A secret link is never shown on screen — only copied.
 *
 * Meaning is never carried by colour alone: who may open a row is a WORD.
 */
import type { PreviewRow } from "@tentacle/protocol";
import { clampCursor } from "./apps-view.ts";
import { paletteWindow } from "./commands.ts";
import type { PanelKeyState, PanelView, PanelViewRow } from "./tree-panel.ts";

const fit = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;

const note = (text: string, width: number): PanelView => ({
  title: "Previews",
  rows: [{ text: fit(`  ${text}`, width), kind: "note", selected: false }],
  hint: "esc close",
  start: 0,
});

/** Who may open a row, and how its tunnel is. */
function audience(row: PreviewRow): string {
  if (row.link === undefined) return "paired devices";
  return `${row.link.public ? "PUBLIC" : "secret link"} · ${row.link.state}`;
}

/** The `/previews` panel: two rows per preview — who and what, then the address. */
export function previewsView(
  rows: readonly PreviewRow[] | undefined,
  cursor: number,
  width: number,
  maxBody: number,
): PanelView {
  if (rows === undefined) return note("not reported by this session yet", width);
  if (rows.length === 0) return note("No shared containers in this session.", width);
  const at = clampCursor(cursor, rows.length);
  const window = paletteWindow(rows.length, at, Math.max(1, Math.floor(maxBody / 2)));
  const out: PanelViewRow[] = [];
  for (let i = window.start; i < window.end; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const selected = i === at;
    out.push({
      text: fit(
        `${selected ? "▸" : " "} ${audience(row)} · ${row.name} port ${row.containerPort}`,
        width,
      ),
      kind: "head",
      selected,
    });
    out.push({
      text: fit(`    ${row.link?.url ?? "no web link"}`, width),
      kind: "child",
      selected: false,
    });
  }
  const more =
    window.end - window.start < rows.length
      ? ` · ${window.start + 1}–${window.end} of ${rows.length}`
      : "";
  return {
    title: `Previews (${rows.length})`,
    rows: out,
    hint: `↑↓ select · c copy link · s stop · esc close${more}`,
    start: window.start,
  };
}

export type PreviewsKeyAction = "up" | "down" | "copy" | "stop" | "close" | "none";

export function previewsKey(input: string, key: PanelKeyState): PreviewsKeyAction {
  if (key.escape === true || input === "q") return "close";
  if (key.upArrow === true) return "up";
  if (key.downArrow === true) return "down";
  if (input === "c") return "copy";
  return input === "s" ? "stop" : "none";
}

/** What the user is told after a copy (`failed`: why it did not happen). */
export function previewCopyNotice(row: PreviewRow, failed: string | undefined): string {
  if (failed !== undefined) return `_The link of ${row.name} was not copied: ${failed}_`;
  return row.link?.public
    ? `_Copied the public address of ${row.name}._`
    : `_Copied the secret link of ${row.name}. Whoever has it can use the service._`;
}

/** What the user is told after a stop. */
export function previewStopNotice(
  name: string,
  result: { readonly ok: boolean; readonly reason?: string },
): string {
  return result.ok
    ? `_Stopped sharing ${name}._`
    : `_${name} was not stopped: ${result.reason ?? "the daemon refused"}_`;
}
