/**
 * Bracketed-paste handling.
 *
 * With mode 2004 enabled, a terminal wraps pasted text in `ESC [200~` … `ESC
 * [201~`. Ink may deliver the whole thing in one input event or split it, and
 * may or may not strip the leading ESC — so this is a tiny state machine fed one
 * input chunk at a time. It strips the markers (and any ESCs) and yields the
 * pasted content once the closing marker arrives, carrying a buffer across
 * chunks in between. Pure and framework-free.
 */
const START = "[200~";
const END = "[201~";
// Abandon a paste whose closing marker never arrives once this many characters
// have accumulated: without a cap, a lost/garbled `[201~` (interrupted paste,
// terminal quirk) leaves the machine "in paste" forever, silently swallowing
// every later keystroke. On overflow we flush what we have and reset. Generous
// enough that a real multi-megabyte paste still completes normally.
const DEFAULT_MAX_BUFFER = 1_000_000;

export interface PasteStep {
  /** Completed pasted text (markers stripped), present once a paste finished. */
  readonly text?: string;
  /** Carry-over while a paste spans chunks; null when not inside a paste. */
  readonly buffer: string | null;
  /** True if this chunk was part of a bracketed paste (caller should consume it). */
  readonly consumed: boolean;
}

/** Remove any bracketed-paste markers from a string (defensive leak guard). */
export function stripPasteMarkers(text: string): string {
  return text.split(START).join("").split(END).join("");
}

// A lone control byte must never be inserted as text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detects control bytes
const CONTROL_RE = /[\x00-\x1f\x7f]/;
// Control bytes to drop from a pasted chunk; `\t` (\u0009) and `\n` (\u000a) are
// intentionally outside this class (the prompt is multi-line) after CRLF→LF.
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control bytes from pastes
const PASTE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Normalise a pasted chunk: CRLF→LF, then drop stray control bytes. */
export function sanitizePasted(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(PASTE_CONTROL_RE, "");
}

/**
 * Clean a key/paste chunk for insertion into the buffer: a single character is
 * dropped when it is a control byte; a multi-character chunk (the terminal's
 * native paste) is unmarked and sanitised so an embedded newline neither breaks
 * the line nor submits. Returns "" when nothing insertable remains.
 */
export function sanitizeInsert(char: string): string {
  return char.length === 1
    ? CONTROL_RE.test(char)
      ? ""
      : char
    : sanitizePasted(stripPasteMarkers(char));
}

/** Feed one input chunk through the bracketed-paste state machine. */
export function stepPaste(
  buffer: string | null,
  chunk: string,
  maxBuffer: number = DEFAULT_MAX_BUFFER,
): PasteStep {
  // ESCs are noise for marker detection (Ink may or may not strip the leading one).
  const raw = chunk.split("\u001b").join("");
  const inPaste = buffer !== null;
  if (!inPaste && !raw.includes(START)) {
    return { buffer: null, consumed: false };
  }
  let buf = (buffer ?? "") + raw;
  const start = buf.indexOf(START);
  if (start !== -1) {
    buf = buf.slice(start + START.length);
  }
  const end = buf.indexOf(END);
  if (end !== -1) {
    return { text: buf.slice(0, end), buffer: null, consumed: true };
  }
  // Closing marker still missing and we've buffered too much: give up on the
  // paste, flush the accumulated text, and reset so input is never frozen.
  if (buf.length > maxBuffer) {
    return { text: buf, buffer: null, consumed: true };
  }
  return { buffer: buf, consumed: true };
}
