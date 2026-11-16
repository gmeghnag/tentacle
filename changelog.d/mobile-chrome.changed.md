- **The phone's dark theme is soft warm graphite, not black, and its chrome
  is thin and hairline-quiet.** The dark palette's neutral ramp is the
  owner-approved B1 "grafite calda" (`#1F1F1E` page, `#2A2A28` card/sheet,
  `#33332F` fill) with a one-step-below drawer surface and two new section-band
  surfaces; the dark red was lifted to `#FF6D65` so it still clears 4.5:1 on the
  new fill. Sheets lose their heavy 38 pt corners for 14 pt, cards go square for
  the new banded lists, and `Icon` now accepts the `thin`/`light` SF Symbol
  weights plus the hamburger and gear glyphs the restyle needs. Every screen
  header drops its blurred glass circles for bare thin glyphs on the same 44 pt
  touch target (`GlassButton` survives only over the camera), the chat header
  ends in a single hairline and reads its context fraction as a small ring next
  to "…" instead of a flat 2 pt bar — the ring is plain `View`s, so no
  `react-native-svg` and no native rebuild — and the chat header itself is
  50 pt instead of 56. The rename dialog keeps its 26 pt alert corners and the
  light palette is otherwise untouched. Grouped lists become full-width bands:
  one edge-to-edge surface per section, with a small uppercase label above it,
  a hairline on its top and bottom edges, and the section's footnote beneath —
  the band always one step above the surface it sits on, so a sheet's own
  ground moves down a step to keep its bands separate. In a banded row the
  label never truncates: a long value shortens instead, keeping the end that
  tells values apart (a path its tail, a model id both ends), and at the
  largest text sizes the value drops under its label rather than squeezing it.
  Settings, Computers, Sessions, Pair and Session info all draw their sections
  that way now — one band per section, with the section's notes on the band's
  own margin — and the old inset grouped card and its separate section header
  are gone. The chat's back chevron becomes a
  hamburger that opens a **sessions drawer** over the conversation: the
  computer as its title (tap to list another paired computer's sessions, or
  pair one), Running / Recent / a collapsed Archived · n, the open session
  highlighted, long-press → Rename (by id, no open), a magnifier into the
  Sessions screen's search, and Settings at the bottom. Tapping a row switches
  session — detaching only, never closing it — and after a switch to another
  computer the back swipe lands on THAT computer's list. A list that cannot be
  read says so with Retry, never "no sessions"; with Reduce Motion the drawer
  fades instead of sliding.
