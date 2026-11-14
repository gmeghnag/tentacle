- **The TUI's frame left `App.tsx`: the derived rows are one pure view-model and
  the tree is one dumb component.** Everything the frame is computed from — the
  palette's window, the input box's height, the panel/dock/drawer/pill/reply
  views, the transcript's viewport and the row a pill click lands on — is now
  `packages/tui/src/app-layout.ts`'s `frameLayout(input)`, a React-free function
  with its own unit test, and the JSX itself is `packages/tui/src/AppView.tsx`,
  which owns no state, no ref, no effect and no geometry: it paints the model it
  is handed. The decisions stay the existing pure modules' (`statusTokens`,
  `panelView`, `backgroundListView`, `pillView`, `windowFor`, …); the hook that
  owns an effect (`useDockClock`) and the transcript layout whose consumers are
  App's effects stayed where they were, so the effect list keeps its order. The
  JSX moved verbatim (the frame set and the SGR/pill-click pins are unchanged),
  the blank-row rule that keeps Ink from collapsing rows moved with it, and
  `App.tsx` loses 317 lines. No user-visible behaviour changes.
