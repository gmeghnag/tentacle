- **Artifacts open properly on the phone.** An HTML page, a Markdown document,
  an SVG or a text artifact now opens in its viewer instead of saying "Couldn't
  keep this file"; the viewer covers the whole screen instead of opening as a
  half sheet under the gallery; and the gallery's close button no longer sits
  on the status-bar clock. A chart with a currency unit or a long date axis no
  longer fails on iOS (whose Intl lacks `formatToParts`, or returns no parts),
  and the ∴ thought glyph is a little larger. The live "Thinking…" node now
  breathes (its ∴ dots light up in turn, and a shimmer crosses the word; still
  under Reduce Motion), and the Activity sheet's Scheduled group shows the
  session's real wakes (how many, and the next one; a tap opens them in
  Session info) instead of a greyed "soon". Tapping an artifact's card in the
  conversation now opens that artifact (closing it returns to the
  conversation) instead of the artifacts list.
