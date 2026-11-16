- **The TUI's row bullet no longer turns into an emoji.** The bullet that opens a
  tool call, a reply and a notice was `⏺` (U+23FA, the record symbol), which is
  emoji-capable: on a terminal whose monospace font lacks it — Windows Terminal
  under WSL, Safari on iOS — the OS substituted its colour-emoji font and drew a
  "record button", sometimes two cells wide. It is now `●` (U+25CF BLACK
  CIRCLE), which has no emoji form and is present in practically every monospace
  font. The blink's ON and OFF halves are still the SAME character (OFF under the
  SGR conceal attribute), so the row keeps its exact cells and nothing moves at
  1 Hz.
