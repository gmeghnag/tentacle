- **The TUI's session link moved out of `App.tsx` into one hook.** How the TUI
  follows a session — the activity feed it streams into the transcript, the
  subscription set a follow installs and tears down, the single way the view
  moves to another session, and a `/sessions` switch — now executes through
  `packages/tui/src/useSessionLink.ts`, which owns no state and no effect: every
  ref another driver also reads or writes (`heldRef`, `streamCtrlRef`,
  `sendNowRef`, `warmingRef`, the clear's latches, the wake model, `switchingRef`,
  `onActivityRef`) still lives in `App` and is passed in, so each read keeps its
  source and two keys with no render between them behave as before. The
  decisions remain the existing pure modules' (`nextStep`, `historyAction`,
  `closedNotice`, `openFailedNotice`, `stayingNotice`, `switchRefusedNotice`,
  `resetDock`, `noteSent`, the notice builders, `state.ts`'s and `wakeStep`), and
  the `onActivity` ↔ `swapSession` cycle keeps its late binding.
  `App.tsx` loses 261 lines. No user-visible behaviour changes.
