/**
 * Terminal escape sequences out of daemon-supplied text (B3). The phone shows
 * tool output and arguments as plain `Text` and never interprets an escape, so
 * this is broader than the TUI's SGR-only regex: every CSI (`ESC [ … final`)
 * and every OSC (`ESC ] … BEL` or `ESC ] … ESC \`) goes. A lone ESC that starts
 * no sequence is left as is (nothing to strip).
 */

// CSI: ESC [ parameter bytes (0x30–0x3F)* intermediate bytes (0x20–0x2F)* final byte (0x40–0x7E).
// OSC: ESC ] anything up to BEL or ST (ESC \).
const ANSI = new RegExp(
  [
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`,
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  if (!text.includes("\u001b")) {
    return text;
  }
  return text.replace(ANSI, "");
}
