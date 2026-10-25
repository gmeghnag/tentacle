/**
 * Rows of a user message — sent (in the transcript) or queued (above the
 * input) — on a background that spans the full terminal width. Pure.
 *
 * The padding must be added AFTER wrapping (the wrapper does not pad), so
 * the message is wrapped here to `width` and every row comes out exactly
 * `width` cells wide; `wrapLines` then leaves it alone. A blank line inside
 * the message is a padded row too, never an empty string.
 */
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { type MessageStyle, theme } from "./theme.ts";

export type MessageTone = "sent" | "queued";

const PREFIX_W = 2;

// Every width comes from `string-width`, the measure wrap-ansi and Ink use, so
// a padded row is never one cell off (an overfull row wraps into a spill row).
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Queued and sent share one marker: only the text colour tells them apart.
const marker = (): string => theme.accent.bold("› ");

function dress(
  prefix: string,
  piece: string,
  width: number,
  tone: MessageTone,
  style: MessageStyle,
): string {
  const { bg, queuedFg } = style;
  const pad = " ".repeat(Math.max(0, width - PREFIX_W - stringWidth(piece)));
  const body = tone === "queued" ? queuedFg(piece) : piece;
  return bg(prefix + body + pad);
}

/** A message as wrapped, full-width rows: `› ` on the first, two spaces after. */
export function messageRows(
  text: string,
  width: number,
  tone: MessageTone = "sent",
  style: MessageStyle = theme.message.dark,
): string[] {
  const w = Math.max(PREFIX_W + 1, Math.floor(width));
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    const pieces =
      line === "" ? [""] : wrapAnsi(line, w - PREFIX_W, { hard: true, trim: false }).split("\n");
    for (const piece of pieces) {
      rows.push(dress(rows.length === 0 ? marker() : "  ", piece, w, tone, style));
    }
  }
  return rows;
}

/**
 * Queued messages: one row each (the App sizes the bottom area at one row per
 * message, plus one for the hint), same shape as a sent one, text in grey. A
 * multi-line message is flattened; a long one is cut with `…`. `hint` gets
 * its own grey row UNDER the last message, off the message background.
 */
export function queuedRows(
  texts: readonly string[],
  width: number,
  hint?: string,
  style: MessageStyle = theme.message.dark,
): string[] {
  const w = Math.max(PREFIX_W + 1, Math.floor(width));
  const rows = texts.map((text) => {
    const room = Math.max(1, w - PREFIX_W);
    const flat = text.replace(/\s*\n\s*/g, " ");
    const fits = stringWidth(flat) <= room;
    const limit = fits ? room : room - 1;
    let cut = "";
    let used = 0;
    for (const { segment } of segmenter.segment(flat)) {
      const cw = stringWidth(segment);
      if (used + cw > limit) {
        break;
      }
      cut += segment;
      used += cw;
    }
    return dress(marker(), fits ? cut : `${cut}…`, w, "queued", style);
  });
  if (hint !== undefined && rows.length > 0) {
    rows.push(theme.subtle(`  ${hint}`));
  }
  return rows;
}
