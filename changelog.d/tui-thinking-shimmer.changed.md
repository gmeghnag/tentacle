- **The TUI's turn indicator shimmers.** `Thinking…` / `Working…` now carries a
  soft highlight that sweeps left to right across the word and rests for a moment
  before repeating, matching the phone's mockup, instead of sitting in one flat
  accent colour. The sweep rides the spinner's existing 80 ms re-render — no new
  timer — and is computed by a pure module (`packages/tui/src/shimmer.ts`) that
  only ever returns runs of the label's own text, so the row cannot shift by a
  cell. The two highlight tones are per-mode palette tokens, gated by the light
  palette's contrast test, and with colour off (`NO_COLOR`, no TTY) the row is
  exactly the plain label it was before.
