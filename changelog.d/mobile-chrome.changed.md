- **The phone's dark theme is soft warm graphite, not black, and its grouped
  screens read as full-width bands.** The dark palette's neutral ramp is the
  owner-approved B1 "grafite calda" (`#1F1F1E` page, `#2A2A28` card/sheet,
  `#33332F` fill) with a one-step-below drawer surface and two new section-band
  surfaces; the dark red was lifted to `#FF6D65` so it still clears 4.5:1 on the
  new fill. Sheets lose their heavy 38 pt corners for 14 pt, cards go square for
  the new banded lists, the chat header drops 56 → 50 pt, and `Icon` now accepts
  the `thin`/`light` SF Symbol weights plus the hamburger and gear glyphs the
  restyle needs. This slice changes tokens and the icon seam only — no screen code
  was rewired — but the corners, the chat header height and the dark ramp are
  visible at once: grouped cards and sheets take their new radii, the rename
  dialog keeps its 26 pt alert corners, and behaviour is unchanged.
