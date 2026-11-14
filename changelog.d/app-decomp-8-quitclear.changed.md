- **The TUI's quit and clear executors moved out of `App.tsx` into one hook.**
  `/quit` (`/exit`) and `/clear` now execute through
  `packages/tui/src/useQuitClear.ts`, which owns the wiring but no state of its
  own: every latch it reads (`exitPendingRef`, `clearingRef`, `ownClearsRef`,
  `clearAfterTurnRef`, `runClearRef`) stays in `App` because the turn's settle,
  the session `watch` and `swapSession` also read or write it. The decisions
  remain the existing pure modules' (`quitCommandStep`, `clearCommandStep`,
  `clearNoopNotice`), and `RunQuit` moved next to the hook that reads it, so the
  package surface is unchanged. No user-visible behaviour changes.
