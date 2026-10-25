/**
 * What a spilled tool result shows instead of the model's banner
 * (docs/feat/tui-spill-note.md): a short note, the path only in ctrl+o, then
 * the head/tail preview. Built from the structured `spill` alone — the banner
 * text and its `…[N characters omitted]…` marker are never parsed.
 *
 * Pure and React-free: plain strings, no colours (the renderer owns those).
 */
import type { ToolResultSpill } from "@tentacle/core";
import { oneLine } from "./commands.ts";
import { formatChars } from "./format.ts";
import { cleanReadText } from "./read-highlight.ts";

export interface SpillView {
  /** "40.8k chars · too large, the model reads it in parts" (or the could-not-be-saved note). */
  readonly note: string;
  /** Expanded (ctrl+o) and saved only: "saved to <path>" | "saved in the pod to <path>". */
  readonly where?: string;
  /** The preview's first part, as displayed. */
  readonly head: string;
  /** "… 39.6k chars omitted …"; absent when nothing was omitted. */
  readonly omitted?: string;
  /** The preview's last part, as displayed ("" when nothing was omitted). */
  readonly tail: string;
}

/** A part as displayed: cleaned like a read (one rule for both paths), no trailing newlines. */
function shown(text: string): string {
  return cleanReadText(text).replace(/\n+$/, "");
}

export function spillView(
  spill: ToolResultSpill,
  o: { readonly expanded: boolean; readonly inPod: boolean },
): SpillView {
  const size = `${formatChars(spill.chars)} chars`;
  const note =
    spill.path !== undefined
      ? `${size} · too large, the model reads it in parts`
      : `${size} · too large, could not be saved — the model sees only this preview`;
  // The path is pod-supplied text in a pod: one display line, always.
  const where =
    o.expanded && spill.path !== undefined
      ? `${o.inPod ? "saved in the pod to" : "saved to"} ${oneLine(spill.path)}`
      : undefined;
  return {
    note,
    ...(where !== undefined ? { where } : {}),
    head: shown(spill.head),
    ...(spill.omitted > 0 ? { omitted: `… ${formatChars(spill.omitted)} chars omitted …` } : {}),
    tail: spill.omitted > 0 ? shown(spill.tail) : "",
  };
}
