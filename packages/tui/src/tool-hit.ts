/**
 * Which tool call is under a screen row (docs/feat/tui-tool-expand.md).
 *
 * A click toggles ONE call, so the App must turn the terminal cell an SGR report
 * gives (1-based row) into a tool-call id. The layout already knows the answer:
 * `layoutTranscript` returns one `LaidItem` per non-empty item, in transcript
 * order, each carrying its global `start` row and its final wrapped `rows`. The
 * App maps the report's row into an ABSOLUTE buffer row (`win.start + y - 1`,
 * the same coordinate the selection uses), and this module resolves that row to
 * a call id.
 *
 * Only a call's HEADER row is a control: a row of the wrapped command, a row of
 * the tool body, or a blank separator row belongs to the text, and a click there
 * does nothing new (it stays a zero-length selection, as today).
 *
 * A click only counts INSIDE the transcript viewport. The terminal reports a
 * cell for every row of the screen, and only the first `viewport` rows are the
 * transcript: the prompt rule, the input box and the status bar are below it.
 * When the viewport is scrolled up, `win.start + y - 1` also walks past the
 * window's END into real transcript rows the user cannot see, so a click on the
 * input would toggle a hidden call (Review finding 1). `toolCallAtViewport`
 * takes the screen row and the visible window and bounds it, so the guard lives
 * here with the hit-test and not inline in the App.
 *
 * Pure and framework-free (AGENTS §7): a laid-out transcript + a row in, an id
 * or null out.
 */
import type { LaidItem } from "./render-lines.ts";
import type { ScrollWindow } from "./scroll.ts";

/**
 * The id of the tool call whose header row is `absRow`, or null when that row
 * is not a tool header (a non-tool item, a continuation row, a body row, a
 * separator row, or past the end).
 *
 * `absRow` is absolute in the whole transcript buffer, NOT a screen row: the
 * caller adds the scroll window's start (the terminal's viewport windows the
 * transcript, `scroll.ts: windowFor`). Taking the absolute row is what makes
 * "click while scrolled up" correct by construction.
 */
export function toolCallAt(laid: readonly LaidItem[], absRow: number): string | null {
  // Binary search for the last item starting at or before `absRow`.
  let lo = 0;
  let hi = laid.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = laid[mid]?.start ?? 0;
    if (start <= absRow) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const item = found >= 0 ? laid[found] : undefined;
  if (!item || item.id === "") {
    return null;
  }
  // The header is row 0 of the item (`toolLines` opens with it); every other
  // row of the item — a wrapped command continuation or a body row — is text.
  return absRow === item.start ? item.id : null;
}

/**
 * The id of the tool call under SCREEN row `y` (1-based, as SGR reports it), or
 * null when that row is outside the transcript viewport or is not a header.
 *
 * `visible` is the transcript's window (`scroll.ts: windowFor`), whose `end`
 * bounds the viewport: a row at or below `end - start` is the prompt rule, the
 * input box or the status bar. `win.start` is added here so the caller never
 * does row arithmetic itself.
 */
export function toolCallAtViewport(
  laid: readonly LaidItem[],
  visible: ScrollWindow,
  y: number,
): string | null {
  const screenRow = y - 1; // the report's rows are 1-based
  if (screenRow < 0 || screenRow >= visible.end - visible.start) {
    return null; // the input box, the status bar, or above the viewport
  }
  return toolCallAt(laid, visible.start + screenRow);
}
